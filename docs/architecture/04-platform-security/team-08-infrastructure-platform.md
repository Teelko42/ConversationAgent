# Team 8 — Infrastructure & Platform

> Lane **F04** · Product **Aizen** ("AI explains the room") · Cloud **Azure** (D03)
> Scale targets **D02** · Latency budget **D07** · Event backbone **D08** (this
> lane owns the final word) · Datastores **D09** (this lane owns the final word).
>
> This document designs the production platform that hosts every other lane
> (F01 capture/STT, F02 intelligence core, F03 experience/orchestration). It does
> not redesign their application logic — it provisions, scales, secures, observes,
> and pays for it. Security/privacy/compliance controls live in the companion doc
> `team-09-security-privacy-compliance.md`.

---

## 1. Architecture

### 1.1 Design principles

| Principle | Implication |
|---|---|
| **Real-time hot path is sacred** | The speech→first-card path (D07: p50 ≤ 3 s) runs on warm, low-jitter, pre-provisioned compute. No cold starts on the hot path. |
| **Event-streaming spine** | Everything downstream of capture is driven by a durable, ordered, per-session event log (D08). Services are stateless consumers. |
| **Stateless compute, stateful stores** | All app tiers (gateway, orchestrator, extraction, explanation) are horizontally scalable stateless services; state lives in the log, Postgres, Redis, Blob, vector/graph DBs. |
| **Multi-tenant by default, isolatable by tier** | Pooled multi-tenant infra at MVP; row/namespace isolation; silo (dedicated VNet/cluster) option for enterprise + HIPAA at scale. |
| **Cost follows the workload** | LLM/STT inference dominates cost. Spend the platform budget on observability + autoscaling that keeps GPU/inference utilization high, not on idle headroom. |
| **Region-portable** | Every regional stack is built from the same IaC module so eastus / westus (DR) / westeurope (residency) are identical except data. |

### 1.2 Logical architecture (layers)

```
                         ┌──────────────────────────────────────────────┐
   Clients (D11)         │ Web (primary) · Desktop (Tauri) · Mobile      │
                         └───────────────┬──────────────────────────────┘
                                         │ WSS / WebRTC / HTTPS
                         ┌───────────────▼──────────────────────────────┐
   Edge (Front Door +    │ Front Door (static+API) · Azure Front Door     │
   WAF + DDoS)           │ WAF · DDoS Protection · Entra External ID/OIDC │
                         └───────────────┬──────────────────────────────┘
                         ┌───────────────▼──────────────────────────────┐
   Real-time gateway     │ Realtime Gateway (WebSocket/WebRTC term.)      │
   (Container Apps, warm)│ session auth · consent gate · backpressure     │
                         └───────────────┬──────────────────────────────┘
                                         │ produce AudioFrame / TranscriptSegment
                         ┌───────────────▼──────────────────────────────┐
   EVENT BACKBONE (D08)  │  Kafka-compat log (Event Hubs Dedicated) —     │
                         │  per-session partitioned topics: audio.raw ·   │
                         │  transcript.seg · concept.card · insight.item ·│
                         │  graph.delta + Service Bus/Event Grid control  │
                         └──┬──────────┬──────────┬──────────┬───────────┘
        ┌──────────────────┘          │          │          └─────────────┐
   ┌────▼────┐   ┌──────────▼──┐  ┌────▼──────┐  ┌▼──────────┐   ┌─────────▼────┐
   │ STT svc │   │ Extraction  │  │ Explanation│  │ Research/  │   │ Graph builder│
   │ (F01)   │   │ (F02 T3)    │  │ (F02 T4)   │  │ RAG (F02T5)│   │ (F02)        │
   │ GPU/host│   │ CPU+LLM API │  │ LLM API    │  │ LLM+search │   │ CPU          │
   └─────────┘   └─────────────┘  └────────────┘  └───────────┘   └──────────────┘
        │              │               │               │                 │
        └──────────────┴───────┬───────┴───────────────┴─────────────────┘
                       ┌───────▼─────────────────────────────────────────┐
   DATASTORES (D09)    │ PostgreSQL Flexible Server (relational+pgvector)  │
                       │ Azure AI Search/Pinecone (vector @ scale) · graph│
                       │ DB (@ scale) · Azure Cache for Redis (cache/sess)│
                       │ Blob (audio/artifacts) · Cosmos DB (idempot/log) │
                       └──────────────────────────────────────────────────┘
```

### 1.3 Network topology (per region)

```
Azure Region (e.g. eastus)
└─ VNet 10.0.0.0/16  (one per environment: prod / staging)
   ├─ Public subnets (3 AZ)   : App Gateway, NAT GW, Front Door
   ├─ Private-app subnets (3) : Container Apps (gateway/services), Event Hubs
   ├─ Private-gpu subnets (3) : AKS GPU node pool (self-host STT/LLM)
   ├─ Private-data subnets(3) : PostgreSQL, Azure Cache for Redis, AI Search, graph DB
   └─ Private Endpoints       : Blob, Cosmos DB (gateway) ; Key Vault,
                                Azure AI, ACR, Entra, Azure Monitor (interface)
   Ingress: Front Door → WAF → App Gateway (HTTPS/WSS) ; WebRTC via Front Door
   Egress : NAT GW (to Anthropic/Deepgram/web-search APIs) ; Private Endpoints
            keep Azure-service traffic off the public internet.
   Tenancy: NSGs least-privilege per tier ; NSGs at subnet edges ;
            Private Link to vendor APIs where offered (no NAT).
```

### 1.4 How a live session flows through the platform

1. Client opens **WSS/WebRTC** to the Realtime Gateway (Container Apps, always warm). Edge terminates TLS at Front Door/App Gateway; Gateway authenticates the session token and checks the **consent gate** (Team 9) before any audio is accepted.
2. Gateway publishes `AudioFrame` to Event Hubs topic `audio.raw` keyed by `session_id` (guarantees per-session order).
3. STT service (F01, GPU on AKS or hosted vendor) consumes `audio.raw`, emits `TranscriptSegment` to `transcript.seg`.
4. Extraction (F02 T3) consumes `transcript.seg`, emits `ConceptCard` + `graph.delta` + `InsightItem`.
5. Explanation (F02 T4) and Research/RAG (F02 T5) enrich cards; results stream back to the Gateway over the same WSS connection (the Gateway subscribes to the per-session result topics).
6. Durable artifacts land in PostgreSQL / vector / graph / Blob; Redis holds hot session state; everything is observable via OTel traces correlated by `session_id` + `seq`.

---

## 2. Compute

### 2.1 Compute placement matrix

| Workload | Service | Compute | Why | Scaling signal |
|---|---|---|---|---|
| Realtime Gateway (WSS/WebRTC) | F01 edge | **Azure Container Apps** (warm, min replicas) | Long-lived sticky connections, no cold start tolerated, simple ops | Active WS connections / CPU |
| STT — hosted path (MVP) | F01 | Vendor (Deepgram/AssemblyAI) via Private Link/NAT | Fastest to ship, no GPU ops, streaming SLAs | n/a (vendor) |
| STT — self-host path (scale/enterprise/HIPAA) | F01 | **AKS GPU** node pool (NC/ND-series `A10`-class, or accelerator equivalents for Parakeet-class) | Cost at volume, data residency, no-3rd-party-audio mode | GPU utilization / queue depth |
| Extraction / classification | F02 T3 | **Container Apps** + Azure AI/Anthropic API (Haiku/Sonnet) | CPU-light glue around model calls | Topic lag (Event Hubs consumer lag) |
| Explanation engine | F02 T4 | **Container Apps** + Claude API (Sonnet hot / Opus deep) | Inference is remote; local is orchestration | Consumer lag + token budget |
| Research / RAG | F02 T5 | **Container Apps** + web-search API + vector queries | Burgosity I/O bound | Request rate |
| Agent orchestration | F03 T7 | **Container Apps** | Stateful-ish coordination, lives near event bus | Active session count |
| Async/batch (summaries, re-index, exports) | platform | **Container Apps jobs** on Consumption (spot) + **Azure Durable Functions** | Cost-optimized, non-latency-critical | Queue depth |
| Cron / housekeeping (retention sweeps, DSAR) | platform | **Azure Functions timer trigger → Azure Functions / Durable Functions** | Event-driven, cheap, no idle | schedule |
| Self-host LLM (enterprise/air-gapped) | F02 | **AKS GPU** (ND-series accelerators) running Llama-class via vLLM | Data-residency / BAA-free explanation tier | GPU util |

**Containers vs serverless decision (D-PLAT-01):** the real-time hot path is
**containerized on Container Apps** (predictable warm capacity, sticky sessions,
sub-second p99 dispatch). **Serverless (Azure Functions) is used only off the hot path**
(retention sweeps, DSAR fulfillment, webhooks, export jobs) where cold starts of
100–800 ms are acceptable. GPU work is **AKS**, never Azure Functions. This avoids the
classic mistake of putting a latency-sensitive streaming workload behind Azure Functions
concurrency limits and cold starts.

### 2.2 Why AKS for GPU (not Container Apps)

GPU scheduling, `nvidia-device-plugin`, fractional-GPU sharing (MIG/time-slicing),
cluster-autoscaler-driven GPU autoscaling, and the vLLM/Triton ecosystem are first-class on
Kubernetes. We run **one AKS cluster per region** with a dedicated GPU node pool
and the **cluster autoscaler** for just-in-time GPU provisioning + Consumption (spot) for batch transcription.
Everything else stays on Container Apps to keep ops surface small.

### 2.3 Autoscaling

| Tier | Mechanism | Target |
|---|---|---|
| Container Apps services | Container Apps autoscaling (KEDA) on custom Azure Monitor metric (active sessions, Event Hubs consumer lag) + target-tracking CPU 60% | Keep p95 dispatch < 50 ms |
| AKS GPU | Cluster autoscaler; scale on GPU util 70% + pending-pod; Consumption (spot) for batch, On-Demand for hot path | Keep STT real-time factor < 1.0 |
| Event Hubs | Provisioned throughput units sized to peak; partition count = headroom for 2× concurrent sessions | Consumer lag near 0 on hot topics |
| PostgreSQL | PostgreSQL Flexible Server burstable/general purpose (MVP) → provisioned + read replicas (scale) | CPU < 65%, replica lag < 1 s |

---

## 3. Storage

| Data class | Store | Rationale | Lifecycle |
|---|---|---|---|
| Raw audio (if retained) | **Blob Storage** (`aizen-audio-<region>`), encryption at rest, immutability policy optional | Cheap, durable, lifecycle to Archive; **default OFF** per no-retention mode (Team 9) | Tier to Archive @30 d, expire @ tenant policy (default 0–30 d) |
| Transcripts & artifacts (cards, graphs, insights) | **Blob Storage** + index rows in PostgreSQL | Large text/JSON in Blob, queryable metadata in Postgres | Per-tenant retention policy |
| Relational/transactional (users, tenants, sessions, billing, consent) | **Azure Database for PostgreSQL Flexible Server** | ACID, mature, pgvector available | Continuous backup (PITR) |
| Embeddings | **pgvector** (MVP) → **Azure AI Search / Pinecone** (scale) | Start simple, migrate when index > ~5–10 M vectors or recall/latency degrade | Re-indexable from source |
| Knowledge graph | **Postgres adjacency** (MVP) → **managed graph DB (Cosmos DB Gremlin / Neo4j-class)** (scale) | Adjacency tables fine at MVP; managed graph DB (Gremlin/openCypher) for deep traversals at scale | Rebuildable from `graph.delta` log |
| Cache / session state / rate limits | **Azure Cache for Redis** (cluster mode) | Sub-ms hot session state, pub/sub fan-out, token buckets | TTL'd; ephemeral |
| Idempotency keys / event dedup / audit-append | **Cosmos DB** | Single-digit-ms, serverless, TTL, stream to audit pipeline | TTL on idempotency; audit retained per Team 9 |
| Object/data lake (analytics, model eval) | **Blob Storage + Synapse/serverless SQL** | Cheap query over Parquet; feeds product analytics & cost reporting | Lifecycle to Cool/Archive |

---

## 4. Event streaming + message queues — **D08 final decision**

### 4.1 Decision

> **D08 — CONFIRMED with refinement.** The event backbone is a **Kafka-compatible
> log (Event Hubs Dedicated)** for the durable, ordered, replayable per-session
> stream, **complemented by Azure Service Bus + Azure Event Grid** for control-plane and async
> fan-out work. **At the MVP scale point we start on Event Hubs**
> to cut ops + cost, and **graduate to Event Hubs Dedicated at the Year-1 scale point.** WebSocket
> (transcript/cards to client) and WebRTC (audio ingress) terminate at the
> Realtime Gateway. This is the authoritative D08 statement for all lanes.

### 4.2 Why Kafka-compatible log (Event Hubs Dedicated) over Event Hubs at scale (refinement rationale)

| Dimension | Event Hubs | Kafka-compat log (Event Hubs Dedicated) | Verdict |
|---|---|---|---|
| Ordering | Per-partition | Per-partition (key = `session_id`) | Both OK; Dedicated richer keys |
| Consumer model | Limited consumer groups | Native consumer groups, many independent consumers | **Dedicated** — we have ≥5 independent consumers per stream |
| Replay / retention | ≤ 90 d, per-partition throughput caps | Configurable retention, log compaction | **Dedicated** for compaction (graph deltas) |
| Throughput ceiling | Throughput-unit math | Capacity-unit scaling, much higher | **Dedicated** at North-star |
| Ops burden | Fully managed, trivial | Managed but real Kafka ops | **Event Hubs** wins for MVP simplicity |
| Cost at low volume | Pennies | ~min capacity-unit baseline | **Event Hubs** for MVP |
| Cost at high volume | Throughput-unit sprawl gets pricey | Better $/throughput | **Dedicated** at scale |

**Net:** Event Hubs is the right tool at 200 concurrent sessions; the Kafka-compatible
log (Event Hubs Dedicated) is the right tool at 5,000–50,000. We abstract producers/consumers behind a thin
**EventBus interface** (publish/subscribe with `session_id` key + headers
`tenant_id`, `seq`, `trace_id`) so the swap is a config change, not a rewrite.
**Other lanes assume: a durable, ordered, replayable, per-`session_id` stream
exists, addressed by logical topic name.**

### 4.3 Topic / stream taxonomy

| Topic | Producer | Consumers | Key | Retention | Notes |
|---|---|---|---|---|---|
| `audio.raw` | Gateway (F01) | STT | `session_id` | short (1 h) or **0 in no-retention mode** | Largest volume; never persisted to Blob unless consent+retention on |
| `transcript.seg` | STT (F01) | Extraction, Gateway (display), archive | `session_id` | 24 h hot, then Blob | The F01↔F02 seam (`TranscriptSegment`) |
| `concept.card` | Extraction (F02) | Explanation, Gateway, archive | `session_id` | 24 h | `ConceptCard` |
| `graph.delta` | Extraction (F02) | Graph builder, Gateway | `session_id` | **compacted** | KnowledgeGraph mutations |
| `insight.item` | Extraction (F02) | Gateway, notifications | `session_id` | 24 h | `InsightItem` |
| `control.session` | Gateway/orchestrator | all | `session_id` | 7 d | start/stop/consent/retention-mode events |

### 4.4 Queues (Service Bus) + orchestration (Event Grid/Durable Functions)

- **Service Bus standard queues** for at-least-once async jobs (post-session summary, export,
  re-embedding) with **DLQs** and redrive.
- **Service Bus sessions/FIFO** where strict ordering + exactly-once-ish is needed (billing events).
- **Event Grid** for cross-service control events + scheduled retention/DSAR.
- **Durable Functions** orchestrate multi-step async pipelines (DSAR fulfillment,
  full-session export, model batch eval).

### 4.5 Delivery guarantees & idempotency

- Hot path = **at-least-once**; consumers are **idempotent** keyed on
  `(session_id, seq)` with a Cosmos DB dedup table (TTL'd). `seq` is the
  monotonically increasing field from D06 — the platform enforces it end to end.
- Backpressure: Gateway sheds/queues on consumer lag; clients told to throttle
  audio if STT can't keep real-time factor < 1.0.

---

## 5. Databases + caching — **D09 final decision**

### 5.1 Decision

> **D09 — CONFIRMED.** Azure Database for PostgreSQL Flexible Server (relational + transactional, **pgvector
> at MVP**), dedicated vector store (**Azure AI Search or Pinecone**) at Year-1+,
> graph store (**Postgres adjacency at MVP → managed graph DB (Cosmos DB Gremlin / Neo4j-class)** at scale),
> **Blob Storage** for audio/artifacts, **Azure Cache for Redis** for cache/session state.
> **Refinement: add Cosmos DB** for idempotency/dedup/audit-append (serverless,
> single-digit-ms, TTL) — it is not a replacement for any D09 store, it fills the
> high-write key-value gap Postgres should not carry. This is the authoritative
> D09 statement for all lanes.

### 5.2 Migration triggers (when to graduate)

| From → To | Trigger |
|---|---|
| pgvector → Azure AI Search/Pinecone | > ~5–10 M vectors, or p95 ANN query > 50 ms, or recall drop |
| Postgres-graph → managed graph DB | Graph traversal depth > 3 hops common, or graph > ~50 M edges, or graph queries dominate PostgreSQL CPU |
| PostgreSQL Flexible Server burstable → provisioned + read replicas | Sustained > 65% vCores, or read QPS needs replica fan-out |
| Event Hubs → Event Hubs Dedicated | See §4.2 (Year-1) |

### 5.3 Tenancy & isolation (platform view; controls in Team 9)

- **MVP/Year-1:** pooled multi-tenant; **`tenant_id` on every row + RLS**
  (PostgreSQL Row-Level Security) + tenant-scoped Redis key prefixes + Blob prefix
  per tenant with Key Vault grants.
- **Enterprise/HIPAA at scale:** **silo option** — dedicated PostgreSQL Flexible Server, Key Vault
  customer-managed key per tenant, optionally dedicated VNet/AKS namespace. Selected per-tenant via
  IaC parameter.

---

## 6. CDN / Edge / Networking

| Concern | Service | Notes |
|---|---|---|
| Static assets + SPA | **Front Door / CDN** + Blob origin | Global cache, TLS 1.3, managed identity to Blob |
| API + WSS acceleration | **Front Door** (API behaviors) + **Azure Front Door** for WebRTC/UDP | Front Door gives anycast IPs + Azure-backbone for low-jitter audio |
| WAF | **Azure WAF** | OWASP managed rules, rate-based rules, bot control, per-tenant rate limits |
| DDoS | **Azure DDoS Protection (Standard)** | At Year-1+ for the public edge |
| DNS | **Azure DNS** | Latency + geolocation routing for residency (EU users → westeurope) |
| Private vendor egress | **Private Link** (where vendor supports) else NAT | Keeps STT/LLM traffic off open internet where possible |
| TLS | Managed certs; TLS 1.3 enforced | mTLS internal service mesh optional at scale |

WebRTC ingress for system/mic audio uses **Front Door → Gateway**;
fallback to WSS where WebRTC is blocked by corporate firewalls.

---

## 7. Monitoring & Observability

### 7.1 Stack

| Signal | Tool | Detail |
|---|---|---|
| Metrics | **Azure Monitor** + **Azure Monitor managed Prometheus** for AKS | Custom business metrics: active sessions, STT real-time factor, Event Hubs consumer lag, tokens/min, $/session |
| Logs | **Log Analytics** → **Azure AI Search** (structured JSON, `session_id`/`tenant_id`/`trace_id`) | Log scrubbing for PII before index (Team 9) |
| Traces | **OpenTelemetry** → **Application Insights** (or Tempo/Grafana on managed Prometheus) | One trace per session leg, spans across Gateway→STT→Extraction→Explanation |
| Dashboards | **Azure Managed Grafana** | SLO boards, cost boards, tenant boards |
| Alerting | **Azure Monitor alerts → Action Groups → PagerDuty/Opsgenie** | Tiered (page vs ticket) |
| Synthetic | **Azure Monitor availability tests** canaries | End-to-end "talk → card" canary per region |
| RUM | **Application Insights RUM** | Client-side latency to validate D07 from the user's seat |

### 7.2 SLOs (tied to D07)

| SLO | Target | Error budget | Alert |
|---|---|---|---|
| Session connect success | 99.9% | 0.1% | Page if < 99.5% over 10 min |
| Speech → first card p50 | ≤ 3 s | — | Page if p50 > 3 s / 5 min |
| Speech → first card p95 | ≤ 5 s | 5% over budget | Ticket → page on sustained |
| STT real-time factor | < 1.0 | — | Page if > 1.0 (falling behind live) |
| Event Hubs consumer lag (hot topics) | < 1 s | — | Page if > 5 s |
| API availability | 99.9% (MVP) → 99.95% (scale) | per month | Page |
| Explanation deep stream | ≤ 10 s (best-effort) | 10% | Ticket |

Every span carries `session_id` + `seq` so a single trace reconstructs the D07
latency budget per leg and tells us which lane blew the budget.

---

## 8. Cost optimization + cost model (D02 scale points)

### 8.1 Cost levers

1. **Inference is ~70–85% of total cost.** Optimize there first:
   model tiering (Haiku route → Sonnet hot → Opus deep, D04), prompt caching,
   batching deep explanations, capping tokens/session, semantic-dedup of repeated
   concepts, and **self-hosting STT/open-weight LLM at scale** where unit
   economics beat hosted.
2. **Compute:** Container Apps **reserved capacity / savings plans** + AKS **Consumption (spot) for batch** + right-
   sized warm pools; cluster autoscaler consolidation.
3. **Storage:** Blob lifecycle → Cool/Archive; no-retention mode means most audio is
   never stored at all; compaction on `graph.delta`.
4. **Data transfer:** Private Endpoints + Private Link to cut NAT/egress; Front Door
   offloads origin egress.
5. **Stream:** Event Hubs at MVP, Event Hubs Dedicated only when throughput justifies the baseline.
6. **FinOps:** per-`tenant_id`/per-`session_id` cost attribution via tags + cost exports →
   Synapse/serverless SQL; **Azure Cost Management budgets** alerts; cost-per-session is a first-class SLO.

### 8.2 Cost model

Assumptions: avg session 30 min (D02); audio ~1 MB/min compressed; ~3 concept
cards/min; Sonnet hot path + Haiku routing + occasional Opus deep; hosted STT at
MVP, self-host STT at North-star. Figures are **monthly USD, order-of-magnitude
planning estimates**, infra + 3rd-party inference, excluding salaries. Sessions/mo
≈ MAU × ~8 sessions × 0.5 h. (SKUs mapped to Azure; dollar figures carried from the original model pending Azure repricing.)

| Scale point (D02) | MAU | Peak concurrent | Session-hrs/mo (≈) |
|---|---|---|---|
| MVP | 1,000 | 200 | ~4,000 |
| Year-1 | 100,000 | 5,000 | ~400,000 |
| North-star | 2,000,000 | 50,000 | ~8,000,000 |

**Per-component monthly cost (USD, approx):**

| Component | MVP | Year-1 | North-star | Notes |
|---|---|---:|---:|---:|
| LLM inference (Claude API: route+hot+deep) | $3,000 | $180,000 | $2,400,000 | dominant; falls/hr with caching+tiering; self-host offsets at NS |
| STT | $1,200 (hosted) | $90,000 (hosted) | $350,000 (self-host AKS GPU) | self-host flips cheaper ~Year-1+ |
| Realtime Gateway (Container Apps) | $400 | $9,000 | $80,000 | warm pools scale w/ concurrency |
| F02/F03 services (Container Apps) | $500 | $12,000 | $110,000 | stateless, savings plans |
| Event backbone | $300 (Event Hubs) | $6,000 (Event Hubs Dedicated) | $55,000 (Event Hubs Dedicated) | swap at Year-1 |
| Azure Database for PostgreSQL | $400 (Flexible Server) | $14,000 | $120,000 | +read replicas at scale |
| Vector (pgvector→Azure AI Search/Pinecone) | $0 (in PostgreSQL) | $7,000 | $70,000 | dedicated at scale |
| Graph (PG→managed graph DB) | $0 (in PostgreSQL) | $4,000 | $45,000 | managed graph DB at scale |
| Redis (Azure Cache for Redis) | $300 | $5,000 | $40,000 | session state/cache |
| Blob + Cosmos DB + data lake | $150 | $4,000 | $40,000 | no-retention keeps audio low |
| CDN/edge/WAF/DDoS | $200 | $5,000 (+DDoS Protection $3k) | $45,000 | DDoS Protection from Year-1 |
| Observability (Azure Monitor/Prometheus/Grafana/App Insights) | $400 | $9,000 | $70,000 | scrub+sample to control |
| DR (2nd region warm-standby) | $300 | $12,000 | $130,000 | see §10 |
| Networking (NAT/egress/transfer) | $250 | $7,000 | $60,000 | Private Endpoints cut this |
| **Total infra + inference (≈/mo)** | **~$8,000** | **~$390,000** | **~$3,750,000** | |
| **Cost per session-hr (≈)** | **~$2.00** | **~$0.98** | **~$0.47** | improves with scale + tiering |

**Key takeaways for F05 (product/pricing):** unit cost is inference-bound and
**halves roughly each scale step** via tiering, caching, and self-hosting. A
sustainable price floor is ~**$1–2/active-session-hour** at MVP, dropping toward
**$0.5/hr** at scale — pricing tiers must cover this plus margin. Enterprise/HIPAA
silo tenants carry a dedicated-infra premium (own PostgreSQL Flexible Server + customer-managed key ≈ +$1.5–4k
/mo baseline).

---

## 9. Global scale — multi-region & data residency

| Region | Role | Data |
|---|---|---|
| **eastus** | Primary (US) | Default tenant data; active-active candidate at NS |
| **westus** | DR for US | Warm standby (see §10); can take traffic on failover |
| **westeurope** | EU residency (Year-1+) | EU tenants' data **stays in EU** — separate stack, separate Key Vault, separate stores |

- **Residency model (honors D10):** tenant's `region` attribute pins all of that
  tenant's stores (PostgreSQL, Blob, vector, graph, audio) to its region. Azure DNS
  geolocation routes EU users to the EU stack. **No EU PII crosses to US.** The
  control plane (auth, billing) is global but stores only non-residency-sensitive
  metadata, or is regionalized for strict tenants.
- **Cross-region for LLM:** if Claude API region availability requires US calls
  for EU data, that is gated by Team 9 (DPA/SCCs + redaction) — EU-resident
  enterprise tenants get the **self-host LLM tier in-region** to avoid the
  transfer entirely.
- **At North-star:** US goes **active-active** (eastus + westus) behind
  Azure Front Door with per-session affinity; EU remains a residency island.

---

## 10. Disaster Recovery (RPO/RTO, backups, failover)

### 10.1 Targets

| Tier | Data | RPO | RTO | Strategy |
|---|---|---|---|---|
| **Tier 0 — control plane** (auth, tenant, billing, consent ledger) | PostgreSQL geo-replica | **≤ 1 min** | **≤ 15 min** | PostgreSQL Flexible Server cross-region read replica; promote on failover |
| **Tier 1 — durable artifacts** (transcripts, cards, graphs) | PostgreSQL + Blob object replication | **≤ 5 min** | **≤ 30 min** | Blob cross-region object replication; PostgreSQL replica |
| **Tier 2 — analytics/data lake** | Blob | **≤ 24 h** | **≤ 4 h** | Async replication / re-derive |
| **Live in-flight sessions** | Event Hubs + Redis | **best-effort** | reconnect | Sessions are ephemeral; clients auto-reconnect and resume from last `seq`; no hard RPO on live audio |

### 10.2 Backups

- **PostgreSQL:** continuous PITR (35-day window) + automated snapshots; **cross-region
  read replica** for geo-redundancy.
- **Blob:** versioning + **object replication** to westus (and westeurope stays in EU);
  immutability policy for audit/audio under legal hold.
- **Cosmos DB:** PITR + on-demand backups.
- **Config/IaC:** everything is **Terraform/Bicep in Git**; the platform is
  reproducible from code — infra is itself "backed up" as code.
- **Backup restore is tested quarterly** (game day) and is a compliance control
  for SOC 2 (Team 9).

### 10.3 Failover

- **DR posture = warm standby** (MVP/Year-1): minimal always-on footprint in
  westus (PostgreSQL replica, Blob object replication, IaC ready), scaled up on failover via
  Azure DNS health-check + VMSS/cluster autoscaler scale-out. Targets RTO ≤ 30 min.
- **North-star = active-active US** → near-zero RTO for US.
- **Runbooks** automated via Durable Functions where possible; failover is a tested
  game-day procedure, not a manual scramble.

---

## 11. Infrastructure diagram (deployment, primary region)

```
                         Internet
                            │
                 ┌──────────▼───────────┐
                 │ Azure DNS (geo/latency)│
                 └──────────┬───────────┘
        ┌───────────────────┼───────────────────────┐
        │                   │                        │
 ┌──────▼──────┐   ┌────────▼─────────┐     ┌────────▼─────────┐
 │ Front Door  │   │ Azure Front Door  │     │  WAF / DDoS      │
 │ (static+API)│   │ (WebRTC audio)    │     │  Protection      │
 └──────┬──────┘   └────────┬─────────┘     └──────────────────┘
        └─────────┬─────────┘
            ┌──────▼───────┐  (Public subnets, 3 AZ)
            │  App Gateway  │
            │  (HTTPS/WSS)  │
            └──────┬────────┘
   ┌───────────────▼───────────────────────────┐  (Private-app subnets, 3 AZ)
   │  Container Apps: Gateway · Extraction ·    │
   │  Explanation · Research · Orchestration    │
   └───────┬───────────────────────┬───────────┘
           │ produce/consume        │ model calls (NAT/Private Link)
   ┌───────▼─────────────┐   ┌──────▼─────────────────────────────┐
   │ Event Hubs (3 AZ)   │   │ Anthropic Claude · STT vendor ·     │
   │ per-session topics  │   │ web-search  (egress, DPA-governed)  │
   └───────┬─────────────┘   └─────────────────────────────────────┘
           │ consume (STT GPU)
   ┌───────▼──────────────┐ (Private-gpu subnets)
   │ AKS GPU (autoscaler) │ self-host STT / open-weight LLM
   └───────┬──────────────┘
   ┌───────▼──────────────────────────────────────────────┐ (Private-data, 3 AZ)
   │ PostgreSQL (geo-replica) · Azure Cache for Redis ·    │
   │ Azure AI Search/Pinecone · graph DB · Cosmos DB       │
   └───────┬───────────────────────────────────────────────┘
           │
   ┌───────▼──────────────────────────────────────┐
   │ Blob (encrypted): audio* / artifacts /        │  *audio only if retention ON
   │ data-lake  +  object replication → westus / EU│
   └───────────────────────────────────────────────┘

 Cross-cutting: Key Vault (keys) · Key Vault (secrets) · Entra ID + RBAC (least-priv) ·
 Azure Monitor/Prometheus/App Insights/Grafana · activity logs (→ Team 9 audit) ·
 Terraform/Bicep IaC · DR replica stack in westus (warm standby)
```

---

## D12 required sections

### Architecture
See §1–§7, §11. Event-streaming spine (Event Hubs Dedicated/Event Hubs) with stateless Container Apps
services, AKS GPU for self-host inference, PostgreSQL/Redis/vector/graph/Blob/Cosmos DB
state, Front Door/Azure Front Door edge, full OTel observability.

### Technology recommendations
Azure Container Apps (hot path) · AKS+cluster-autoscaler+GPU (self-host STT/LLM) · Kafka-compatible
log (Event Hubs Dedicated) + Event Hubs (MVP) + Service Bus/Event Grid/Durable Functions · Azure Database for PostgreSQL Flexible Server +
pgvector → Azure AI Search/Pinecone + managed graph DB · Azure Cache for Redis · Cosmos DB · Blob Storage ·
Front Door + Azure Front Door + WAF + DDoS Protection + Azure DNS · Azure Monitor + managed Prometheus +
App Insights + Managed Grafana + OTel · Terraform/Bicep IaC · Key Vault (keys + secrets).

### Risks
| Risk | Sev | Mitigation |
|---|---|---|
| Inference cost runaway | High | Model tiering, caching, token caps, self-host at scale, per-session cost SLO + Cost Management budgets |
| Event Hubs Dedicated ops complexity | Med | Start on Event Hubs; abstract behind EventBus iface; managed Event Hubs Dedicated; runbooks |
| GPU capacity/availability | Med | Multi-instance-family, Consumption (spot)+On-Demand mix, hosted STT fallback |
| Hot-path cold starts | High→Low | No Azure Functions on hot path; warm Container Apps pools |
| Multi-region data leakage (residency) | High | Region-pinned stores per tenant; geo DNS; self-host LLM in-region for EU |
| Single-region outage | Med | Warm standby DR (→active-active at NS); tested game days |
| Vendor lock (Claude/STT) | Med | Azure AI + open-weight self-host tier; abstraction layer |

### Scalability
Stateless services scale on consumer lag/active-session metrics; Event Hubs partitions
sized for 2× peak concurrency; PostgreSQL Flexible Server burstable → provisioned + replicas;
pgvector → dedicated vector DB; Postgres-graph → managed graph DB; Event Hubs → Event Hubs Dedicated. Validated
at the three D02 points in §8.2 (200 → 5,000 → 50,000 concurrent).

### Security
Owned by Team 9. Platform provides the substrate: private subnets, NSGs,
Private Endpoints/Private Link, Key Vault encryption everywhere, Key Vault secrets, Entra ID + RBAC least-priv,
WAF/DDoS Protection, activity logs feeding the audit pipeline, RLS-based tenant isolation,
silo option for enterprise/HIPAA.

### Cost
Full model in §8.2: ~$8k/mo (MVP) → ~$390k/mo (Year-1) → ~$3.75M/mo (North-star);
cost-per-session-hr $2.00 → $0.98 → $0.47. Inference dominates; levers in §8.1.

### MVP scope
Single region eastus, multi-AZ. Container Apps everything; **Event Hubs** (not Event Hubs Dedicated);
hosted STT; **PostgreSQL Flexible Server with pgvector** (no separate vector/graph DB);
Redis; Blob; Azure Monitor + basic App Insights; warm-standby DR optional/manual. Defer AKS
GPU, managed graph DB, dedicated vector DB, DDoS Protection, second region until Year-1 triggers.

### Future enhancements
Active-active multi-region; cell-based architecture for blast-radius isolation;
service mesh (Open Service Mesh/Istio) + mTLS; self-hosted inference fleet with
accelerator hardware for cost; per-tenant cost showback portal; FinOps automation;
chaos engineering program; edge inference for ultra-low-latency partial cards.

### Assumptions
A-PLAT-1 avg session 30 min, ~8 sessions/MAU/mo (D02-derived) · A-PLAT-2 ~1 MB/min
audio compressed · A-PLAT-3 inference is 70–85% of cost · A-PLAT-4 hosted STT at
MVP, self-host economical by Year-1+ · A-PLAT-5 EU residency demand emerges at
Year-1 (drives westeurope).

### Decisions
**D-PLAT-01** hot path = Container Apps containers, serverless only off-path, GPU = AKS ·
**D08 final** = Event Hubs Dedicated at scale, Event Hubs at MVP, behind EventBus abstraction (§4) ·
**D09 final** = PostgreSQL+pgvector→Azure AI Search/Pinecone, PG-graph→managed graph DB, Redis, Blob,
**+Cosmos DB** (§5) · **D-PLAT-02** DR = warm standby → active-active US at NS ·
**D-PLAT-03** residency by tenant region-pinning + geo DNS.

### Tradeoffs
Event Hubs (simple/cheap MVP) vs Event Hubs Dedicated (powerful/cheaper-at-scale) → phase the swap ·
Pooled multi-tenant (cheap) vs silo (isolated, compliant, costly) → offer both ·
Hosted inference (fast to ship) vs self-host (cheaper + residency, ops heavy) →
hosted MVP, self-host at scale · Warm standby (cheap, RTO 30 min) vs active-active
(near-zero RTO, 2× cost) → phase by scale.

### Open questions
OQ-PLAT-1 Azure AI-hosted Claude vs Anthropic API direct — affects residency/BAA
(coordinate w/ Team 9 + F02). OQ-PLAT-2 exact self-host STT model (Whisper vs
Parakeet) GPU sizing — owned by F01, platform provisions. OQ-PLAT-3 do we need
active-active before North-star for an enterprise SLA? OQ-PLAT-4 Pinecone (SaaS,
faster) vs Azure AI Search (in-VNet, residency-clean) for vector at scale.

### Estimated complexity
**High.** Real-time + GPU + multi-region + multi-tenant + event-streaming +
compliance substrate. Largest ongoing-ops surface of any lane. MVP is achievable
by ~2–3 platform engineers; Year-1 needs a dedicated 4–6 person platform/SRE team.
