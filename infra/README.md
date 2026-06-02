# Aizen Infrastructure (Terraform skeleton)

> **Status: skeleton, no live deploy.** This is the MVP topology (doc 03 §2) as
> Terraform module structure. `terraform plan/apply` will **not** run until an Azure
> subscription + credentials exist — that is the hard external gate **MAN-F04-001**
> (Azure tenant/subscriptions/billing owner). The skeleton lets the platform shape,
> sizing, and decisions live in code now; wiring real providers is a Phase-0 task
> once the subscription lands.

## Topology (MVP, D02 = ~200 concurrent, single region eastus, zone-redundant)

```
modules/
  network        VNet, public/app/data subnets (delegated), NAT + private endpoints (TODO)
  eventbus       Event Hubs namespace + hub, per-session partition key (D13 — Event Hubs @ MVP)
  datastores     PostgreSQL Flexible Server + pgvector, Azure Cache for Redis,
                 Blob Storage, Cosmos DB (SQL), Key Vault (D14)
  compute        Container Apps environment + service skeletons (gateway / extract-explain)
  observability  Log Analytics workspaces, metric namespace (cost/SLO dashboards = P0)
```

## Decisions encoded here

| Decision | Where |
|---|---|
| **D13** EventBus = Event Hubs @ MVP → Kafka-compatible log @ Year-1 (behind `EventBus` abstraction) | `modules/eventbus` |
| **D14** PostgreSQL+pgvector, Redis, Blob, +Cosmos DB (idempotency/audit) | `modules/datastores` |
| **D03** single region eastus, zone-redundant | `variables.tf` (`location`, `zone_redundant`) |
| **D-PLAT-01** hot path = Container Apps (no Functions on hot path; GPU=AKS deferred) | `modules/compute` |
| **D10 / D18** no-audio-retention default; audio container lifecycle = expire | `modules/datastores` (Blob lifecycle) |

## What is intentionally deferred (scaling triggers, doc 04)

Kafka-compatible log (MSK / Event Hubs Dedicated), AKS + GPU node pools (self-host
STT/LLM), a graph DB, a dedicated vector DB, DDoS Protection Standard, second
region / EU residency — added when the doc-04 triggers fire, not at MVP.

## How to use (once MAN-F04-001 lands)

```bash
cd infra
az login                       # or set ARM_* env vars for a service principal
terraform init
terraform plan  -var-file=env/mvp.tfvars
terraform apply -var-file=env/mvp.tfvars
```

State backend (Azure Storage with `use_azuread_auth`) is left as a TODO in
`versions.tf` — set it to the subscription's bootstrap storage account before first
`init`.
