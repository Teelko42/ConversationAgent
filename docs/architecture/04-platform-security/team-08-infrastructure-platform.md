# Team 8 — Infrastructure & Platform

> Lane **F04** · Product **Aizen** ("AI explains the room") · Cloud **AWS** (D03)
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
| **Stateless compute, stateful stores** | All app tiers (gateway, orchestrator, extraction, explanation) are horizontally scalable stateless services; state lives in the log, Postgres, Redis, S3, vector/graph DBs. |
| **Multi-tenant by default, isolatable by tier** | Pooled multi-tenant infra at MVP; row/namespace isolation; silo (dedicated VPC/cluster) option for enterprise + HIPAA at scale. |
| **Cost follows the workload** | LLM/STT inference dominates cost. Spend the platform budget on observability + autoscaling that keeps GPU/inference utilization high, not on idle headroom. |
| **Region-portable** | Every regional stack is built from the same IaC module so us-east-1 / us-west-2 (DR) / eu-central-1 (residency) are identical except data. |

### 1.2 Logical architecture (layers)

```
                         ┌──────────────────────────────────────────────┐
   Clients (D11)         │ Web (primary) · Desktop (Tauri) · Mobile      │
                         └───────────────┬──────────────────────────────┘
                                         │ WSS / WebRTC / HTTPS
                         ┌───────────────▼──────────────────────────────┐
   Edge (CloudFront +    │ CloudFront (static+API) · AWS Global Accel.    │
   WAF + Shield)         │ WAF · Shield Adv · Cognito/OIDC at edge        │
                         └───────────────┬──────────────────────────────┘
                         ┌───────────────▼──────────────────────────────┐
   Real-time gateway     │ Realtime Gateway (WebSocket/WebRTC term.)      │
   (Fargate, warm)       │ session auth · consent gate · backpressure     │
                         └───────────────┬──────────────────────────────┘
                                         │ produce AudioFrame / TranscriptSegment
                         ┌───────────────▼──────────────────────────────┐
   EVENT BACKBONE (D08)  │  Kafka (Amazon MSK) — per-session partitioned  │
                         │  topics: audio.raw · transcript.seg ·          │
                         │  concept.card · insight.item · graph.delta     │
                         │  + SQS/EventBridge for control & async fan-out │
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
   DATASTORES (D09)    │ Aurora PostgreSQL (relational + pgvector MVP)     │
                       │ OpenSearch/Pinecone (vector @ scale) · Neptune   │
                       │ (graph @ scale) · ElastiCache Redis (cache/sess) │
                       │ S3 (audio/artifacts) · DynamoDB (idempotency/log)│
                       └──────────────────────────────────────────────────┘
```

### 1.3 Network topology (per region)

```
AWS Region (e.g. us-east-1)
└─ VPC 10.0.0.0/16  (one per environment: prod / staging)
   ├─ Public subnets (3 AZ)   : ALB, NAT GW, Global Accelerator ENIs
   ├─ Private-app subnets (3) : Fargate (gateway/services), MSK brokers
   ├─ Private-gpu subnets (3) : EKS GPU node group (self-host STT/LLM)
   ├─ Private-data subnets(3) : Aurora, ElastiCache, OpenSearch, Neptune
   └─ VPC endpoints           : S3, DynamoDB (gateway) ; KMS, Secrets,
                                Bedrock, ECR, STS, CloudWatch (interface)
   Ingress: CloudFront → WAF → ALB (HTTPS/WSS) ; WebRTC via Global Accel.
   Egress : NAT GW (to Anthropic/Deepgram/web-search APIs) ; VPC endpoints
            keep AWS-service traffic off the public internet.
   Tenancy: SGs least-privilege per tier ; NACLs at subnet edges ;
            PrivateLink to vendor APIs where offered (no NAT).
```

### 1.4 How a live session flows through the platform

1. Client opens **WSS/WebRTC** to the Realtime Gateway (Fargate, always warm). Edge terminates TLS at CloudFront/ALB; Gateway authenticates the session token and checks the **consent gate** (Team 9) before any audio is accepted.
2. Gateway publishes `AudioFrame` to MSK topic `audio.raw` keyed by `session_id` (guarantees per-session order).
3. STT service (F01, GPU on EKS or hosted vendor) consumes `audio.raw`, emits `TranscriptSegment` to `transcript.seg`.
4. Extraction (F02 T3) consumes `transcript.seg`, emits `ConceptCard` + `graph.delta` + `InsightItem`.
5. Explanation (F02 T4) and Research/RAG (F02 T5) enrich cards; results stream back to the Gateway over the same WSS connection (the Gateway subscribes to the per-session result topics).
6. Durable artifacts land in Aurora / vector / graph / S3; Redis holds hot session state; everything is observable via OTel traces correlated by `session_id` + `seq`.

---

## 2. Compute

### 2.1 Compute placement matrix

| Workload | Service | Compute | Why | Scaling signal |
|---|---|---|---|---|
| Realtime Gateway (WSS/WebRTC) | F01 edge | **ECS Fargate** (warm, min replicas) | Long-lived sticky connections, no cold start tolerated, simple ops | Active WS connections / CPU |
| STT — hosted path (MVP) | F01 | Vendor (Deepgram/AssemblyAI) via PrivateLink/NAT | Fastest to ship, no GPU ops, streaming SLAs | n/a (vendor) |
| STT — self-host path (scale/enterprise/HIPAA) | F01 | **EKS GPU** node group (g5/g6 `A10G`, or `inf2`/Trainium for Parakeet-class) | Cost at volume, data residency, no-3rd-party-audio mode | GPU utilization / queue depth |
| Extraction / classification | F02 T3 | **Fargate** + Bedrock/Anthropic API (Haiku/Sonnet) | CPU-light glue around model calls | Topic lag (MSK consumer lag) |
| Explanation engine | F02 T4 | **Fargate** + Claude API (Sonnet hot / Opus deep) | Inference is remote; local is orchestration | Consumer lag + token budget |
| Research / RAG | F02 T5 | **Fargate** + web-search API + vector queries | Burgosity I/O bound | Request rate |
| Agent orchestration | F03 T7 | **Fargate** | Stateful-ish coordination, lives near event bus | Active session count |
| Async/batch (summaries, re-index, exports) | platform | **AWS Batch** on Fargate/Spot + **Step Functions** | Cost-optimized, non-latency-critical | Queue depth |
| Cron / housekeeping (retention sweeps, DSAR) | platform | **EventBridge Scheduler → Lambda / Step Functions** | Event-driven, cheap, no idle | schedule |
| Self-host LLM (enterprise/air-gapped) | F02 | **EKS GPU** (p4d/p5 or `inf2`) running Llama-class via vLLM | Data-residency / BAA-free explanation tier | GPU util |

**Containers vs serverless decision (D-PLAT-01):** the real-time hot path is
**containerized on Fargate** (predictable warm capacity, sticky sessions,
sub-second p99 dispatch). **Serverless (Lambda) is used only off the hot path**
(retention sweeps, DSAR fulfillment, webhooks, export jobs) where cold starts of
100–800 ms are acceptable. GPU work is **EKS**, never Lambda. This avoids the
classic mistake of putting a latency-sensitive streaming workload behind Lambda
concurrency limits and cold starts.

### 2.2 Why EKS for GPU (not ECS)

GPU scheduling, `nvidia-device-plugin`, fractional-GPU sharing (MIG/time-slicing),
Karpenter-driven GPU autoscaling, and the vLLM/Triton ecosystem are first-class on
Kubernetes. We run **one EKS cluster per region** with a dedicated GPU node group
and **Karpenter** for just-in-time GPU provisioning + Spot for batch transcription.
Everything else stays on Fargate to keep ops surface small.

### 2.3 Autoscaling

| Tier | Mechanism | Target |
|---|---|---|
| Fargate services | ECS Service Auto Scaling on custom CW metric (active sessions, MSK consumer lag) + target-tracking CPU 60% | Keep p95 dispatch < 50 ms |
| EKS GPU | Karpenter provisioner; scale on GPU util 70% + pending-pod; Spot for batch, On-Demand for hot path | Keep STT real-time factor < 1.0 |
| MSK | Provisioned brokers sized to peak; partition count = headroom for 2× concurrent sessions | Consumer lag near 0 on hot topics |
| Aurora | Aurora Serverless v2 (MVP) → provisioned + read replicas (scale) | CPU < 65%, replica lag < 1 s |

---

## 3. Storage

| Data class | Store | Rationale | Lifecycle |
|---|---|---|---|
| Raw audio (if retained) | **S3** (`aizen-audio-<region>`), SSE-KMS, Object Lock optional | Cheap, durable, lifecycle to Glacier; **default OFF** per no-retention mode (Team 9) | Tier to Glacier @30 d, expire @ tenant policy (default 0–30 d) |
| Transcripts & artifacts (cards, graphs, insights) | **S3** + index rows in Aurora | Large text/JSON in S3, queryable metadata in Postgres | Per-tenant retention policy |
| Relational/transactional (users, tenants, sessions, billing, consent) | **Aurora PostgreSQL** | ACID, mature, pgvector available | Continuous backup (PITR) |
| Embeddings | **pgvector** (MVP) → **OpenSearch k-NN / Pinecone** (scale) | Start simple, migrate when index > ~5–10 M vectors or recall/latency degrade | Re-indexable from source |
| Knowledge graph | **Postgres adjacency** (MVP) → **Amazon Neptune** (scale) | Adjacency tables fine at MVP; Neptune (Gremlin/openCypher) for deep traversals at scale | Rebuildable from `graph.delta` log |
| Cache / session state / rate limits | **ElastiCache Redis** (cluster mode) | Sub-ms hot session state, pub/sub fan-out, token buckets | TTL'd; ephemeral |
| Idempotency keys / event dedup / audit-append | **DynamoDB** | Single-digit-ms, serverless, TTL, stream to audit pipeline | TTL on idempotency; audit retained per Team 9 |
| Object/data lake (analytics, model eval) | **S3 + Glue + Athena** | Cheap query over Parquet; feeds product analytics & cost reporting | Lifecycle to IA/Glacier |

---

## 4. Event streaming + message queues — **D08 final decision**

### 4.1 Decision

> **D08 — CONFIRMED with refinement.** The event backbone is **Amazon MSK
> (managed Apache Kafka)** for the durable, ordered, replayable per-session
> stream, **complemented by SQS + EventBridge** for control-plane and async
> fan-out work. **At the MVP scale point we start on Amazon Kinesis Data Streams**
> to cut ops + cost, and **graduate to MSK at the Year-1 scale point.** WebSocket
> (transcript/cards to client) and WebRTC (audio ingress) terminate at the
> Realtime Gateway. This is the authoritative D08 statement for all lanes.

### 4.2 Why Kafka/MSK over Kinesis at scale (refinement rationale)

| Dimension | Kinesis Data Streams | Amazon MSK (Kafka) | Verdict |
|---|---|---|---|
| Ordering | Per-shard | Per-partition (key = `session_id`) | Both OK; MSK richer keys |
| Consumer model | Limited fan-out (enhanced fan-out costs) | Native consumer groups, many independent consumers | **MSK** — we have ≥5 independent consumers per stream |
| Replay / retention | ≤ 365 d, per-shard throughput caps | Configurable retention, log compaction | **MSK** for compaction (graph deltas) |
| Throughput ceiling | Shard math (1 MB/s in, 2 MB/s out) | Broker/partition scaling, much higher | **MSK** at North-star |
| Ops burden | Fully managed, trivial | Managed brokers but real Kafka ops | **Kinesis** wins for MVP simplicity |
| Cost at low volume | Pennies | ~min 3-broker cluster baseline | **Kinesis** for MVP |
| Cost at high volume | Shard sprawl gets pricey | Better $/throughput | **MSK** at scale |

**Net:** Kinesis is the right tool at 200 concurrent sessions; Kafka/MSK is the
right tool at 5,000–50,000. We abstract producers/consumers behind a thin
**EventBus interface** (publish/subscribe with `session_id` key + headers
`tenant_id`, `seq`, `trace_id`) so the swap is a config change, not a rewrite.
**Other lanes assume: a durable, ordered, replayable, per-`session_id` stream
exists, addressed by logical topic name.**

### 4.3 Topic / stream taxonomy

| Topic | Producer | Consumers | Key | Retention | Notes |
|---|---|---|---|---|---|
| `audio.raw` | Gateway (F01) | STT | `session_id` | short (1 h) or **0 in no-retention mode** | Largest volume; never persisted to S3 unless consent+retention on |
| `transcript.seg` | STT (F01) | Extraction, Gateway (display), archive | `session_id` | 24 h hot, then S3 | The F01↔F02 seam (`TranscriptSegment`) |
| `concept.card` | Extraction (F02) | Explanation, Gateway, archive | `session_id` | 24 h | `ConceptCard` |
| `graph.delta` | Extraction (F02) | Graph builder, Gateway | `session_id` | **compacted** | KnowledgeGraph mutations |
| `insight.item` | Extraction (F02) | Gateway, notifications | `session_id` | 24 h | `InsightItem` |
| `control.session` | Gateway/orchestrator | all | `session_id` | 7 d | start/stop/consent/retention-mode events |

### 4.4 Queues (SQS) + orchestration (EventBridge/Step Functions)

- **SQS standard** for at-least-once async jobs (post-session summary, export,
  re-embedding) with **DLQs** and redrive.
- **SQS FIFO** where strict ordering + exactly-once-ish is needed (billing events).
- **EventBridge** for cross-service control events + scheduled retention/DSAR.
- **Step Functions** orchestrate multi-step async pipelines (DSAR fulfillment,
  full-session export, model batch eval).

### 4.5 Delivery guarantees & idempotency

- Hot path = **at-least-once**; consumers are **idempotent** keyed on
  `(session_id, seq)` with a DynamoDB dedup table (TTL'd). `seq` is the
  monotonically increasing field from D06 — the platform enforces it end to end.
- Backpressure: Gateway sheds/queues on consumer lag; clients told to throttle
  audio if STT can't keep real-time factor < 1.0.

---

## 5. Databases + caching — **D09 final decision**

### 5.1 Decision

> **D09 — CONFIRMED.** Aurora PostgreSQL (relational + transactional, **pgvector
> at MVP**), dedicated vector store (**OpenSearch k-NN or Pinecone**) at Year-1+,
> graph store (**Postgres adjacency at MVP → Amazon Neptune** at scale),
> **S3** for audio/artifacts, **ElastiCache Redis** for cache/session state.
> **Refinement: add DynamoDB** for idempotency/dedup/audit-append (serverless,
> single-digit-ms, TTL) — it is not a replacement for any D09 store, it fills the
> high-write key-value gap Postgres should not carry. This is the authoritative
> D09 statement for all lanes.

### 5.2 Migration triggers (when to graduate)

| From → To | Trigger |
|---|---|
| pgvector → OpenSearch/Pinecone | > ~5–10 M vectors, or p95 ANN query > 50 ms, or recall drop |
| Postgres-graph → Neptune | Graph traversal depth > 3 hops common, or graph > ~50 M edges, or graph queries dominate Aurora CPU |
| Aurora Serverless v2 → provisioned + read replicas | Sustained > 65% ACU, or read QPS needs replica fan-out |
| Kinesis → MSK | See §4.2 (Year-1) |

### 5.3 Tenancy & isolation (platform view; controls in Team 9)

- **MVP/Year-1:** pooled multi-tenant; **`tenant_id` on every row + RLS**
  (PostgreSQL Row-Level Security) + tenant-scoped Redis key prefixes + S3 prefix
  per tenant with KMS grants.
- **Enterprise/HIPAA at scale:** **silo option** — dedicated Aurora cluster, KMS
  CMK per tenant, optionally dedicated VPC/EKS namespace. Selected per-tenant via
  IaC parameter.

---

## 6. CDN / Edge / Networking

| Concern | Service | Notes |
|---|---|---|
| Static assets + SPA | **CloudFront** + S3 origin | Global cache, TLS 1.3, OAC to S3 |
| API + WSS acceleration | **CloudFront** (API behaviors) + **AWS Global Accelerator** for WebRTC/UDP | GA gives anycast IPs + AWS-backbone for low-jitter audio |
| WAF | **AWS WAF** | OWASP managed rules, rate-based rules, bot control, per-tenant rate limits |
| DDoS | **AWS Shield Advanced** | At Year-1+ for the public edge |
| DNS | **Route 53** | Latency + geolocation routing for residency (EU users → eu-central-1) |
| Private vendor egress | **PrivateLink** (where vendor supports) else NAT | Keeps STT/LLM traffic off open internet where possible |
| TLS | **ACM** certs; TLS 1.3 enforced | mTLS internal service mesh optional at scale |

WebRTC ingress for system/mic audio uses **Global Accelerator → Gateway**;
fallback to WSS where WebRTC is blocked by corporate firewalls.

---

## 7. Monitoring & Observability

### 7.1 Stack

| Signal | Tool | Detail |
|---|---|---|
| Metrics | **CloudWatch** + **Amazon Managed Prometheus (AMP)** for EKS | Custom business metrics: active sessions, STT real-time factor, MSK consumer lag, tokens/min, $/session |
| Logs | **CloudWatch Logs** → **OpenSearch** (structured JSON, `session_id`/`tenant_id`/`trace_id`) | Log scrubbing for PII before index (Team 9) |
| Traces | **OpenTelemetry** → **AWS X-Ray** (or Tempo/Grafana on AMP) | One trace per session leg, spans across Gateway→STT→Extraction→Explanation |
| Dashboards | **Amazon Managed Grafana** | SLO boards, cost boards, tenant boards |
| Alerting | **CloudWatch Alarms → SNS → PagerDuty/Opsgenie** | Tiered (page vs ticket) |
| Synthetic | **CloudWatch Synthetics** canaries | End-to-end "talk → card" canary per region |
| RUM | **CloudWatch RUM** | Client-side latency to validate D07 from the user's seat |

### 7.2 SLOs (tied to D07)

| SLO | Target | Error budget | Alert |
|---|---|---|---|
| Session connect success | 99.9% | 0.1% | Page if < 99.5% over 10 min |
| Speech → first card p50 | ≤ 3 s | — | Page if p50 > 3 s / 5 min |
| Speech → first card p95 | ≤ 5 s | 5% over budget | Ticket → page on sustained |
| STT real-time factor | < 1.0 | — | Page if > 1.0 (falling behind live) |
| MSK consumer lag (hot topics) | < 1 s | — | Page if > 5 s |
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
2. **Compute:** Fargate **Compute Savings Plans** + EKS **Spot for batch** + right-
   sized warm pools; Karpenter consolidation.
3. **Storage:** S3 lifecycle → IA/Glacier; no-retention mode means most audio is
   never stored at all; compaction on `graph.delta`.
4. **Data transfer:** VPC endpoints + PrivateLink to cut NAT/egress; CloudFront
   offloads origin egress.
5. **Stream:** Kinesis at MVP, MSK only when throughput justifies the baseline.
6. **FinOps:** per-`tenant_id`/per-`session_id` cost attribution via tags + CUR →
   Athena; **AWS Budgets** alerts; cost-per-session is a first-class SLO.

### 8.2 Cost model

Assumptions: avg session 30 min (D02); audio ~1 MB/min compressed; ~3 concept
cards/min; Sonnet hot path + Haiku routing + occasional Opus deep; hosted STT at
MVP, self-host STT at North-star. Figures are **monthly USD, order-of-magnitude
planning estimates**, infra + 3rd-party inference, excluding salaries. Sessions/mo
≈ MAU × ~8 sessions × 0.5 h.

| Scale point (D02) | MAU | Peak concurrent | Session-hrs/mo (≈) |
|---|---|---|---|
| MVP | 1,000 | 200 | ~4,000 |
| Year-1 | 100,000 | 5,000 | ~400,000 |
| North-star | 2,000,000 | 50,000 | ~8,000,000 |

**Per-component monthly cost (USD, approx):**

| Component | MVP | Year-1 | North-star | Notes |
|---|---|---:|---:|---:|
| LLM inference (Claude API: route+hot+deep) | $3,000 | $180,000 | $2,400,000 | dominant; falls/hr with caching+tiering; self-host offsets at NS |
| STT | $1,200 (hosted) | $90,000 (hosted) | $350,000 (self-host EKS GPU) | self-host flips cheaper ~Year-1+ |
| Realtime Gateway (Fargate) | $400 | $9,000 | $80,000 | warm pools scale w/ concurrency |
| F02/F03 services (Fargate) | $500 | $12,000 | $110,000 | stateless, savings plans |
| Event backbone | $300 (Kinesis) | $6,000 (MSK) | $55,000 (MSK) | swap at Year-1 |
| Aurora PostgreSQL | $400 (Serverless v2) | $14,000 | $120,000 | +read replicas at scale |
| Vector (pgvector→OpenSearch/Pinecone) | $0 (in Aurora) | $7,000 | $70,000 | dedicated at scale |
| Graph (PG→Neptune) | $0 (in Aurora) | $4,000 | $45,000 | Neptune at scale |
| Redis (ElastiCache) | $300 | $5,000 | $40,000 | session state/cache |
| S3 + DynamoDB + data lake | $150 | $4,000 | $40,000 | no-retention keeps audio low |
| CDN/edge/WAF/Shield | $200 | $5,000 (+Shield Adv $3k) | $45,000 | Shield Adv from Year-1 |
| Observability (CW/AMP/Grafana/X-Ray) | $400 | $9,000 | $70,000 | scrub+sample to control |
| DR (2nd region warm-standby) | $300 | $12,000 | $130,000 | see §10 |
| Networking (NAT/egress/transfer) | $250 | $7,000 | $60,000 | VPC endpoints cut this |
| **Total infra + inference (≈/mo)** | **~$8,000** | **~$390,000** | **~$3,750,000** | |
| **Cost per session-hr (≈)** | **~$2.00** | **~$0.98** | **~$0.47** | improves with scale + tiering |

**Key takeaways for F05 (product/pricing):** unit cost is inference-bound and
**halves roughly each scale step** via tiering, caching, and self-hosting. A
sustainable price floor is ~**$1–2/active-session-hour** at MVP, dropping toward
**$0.5/hr** at scale — pricing tiers must cover this plus margin. Enterprise/HIPAA
silo tenants carry a dedicated-infra premium (own Aurora cluster + CMK ≈ +$1.5–4k
/mo baseline).

---

## 9. Global scale — multi-region & data residency

| Region | Role | Data |
|---|---|---|
| **us-east-1** | Primary (US) | Default tenant data; active-active candidate at NS |
| **us-west-2** | DR for US | Warm standby (see §10); can take traffic on failover |
| **eu-central-1** | EU residency (Year-1+) | EU tenants' data **stays in EU** — separate stack, separate KMS, separate stores |

- **Residency model (honors D10):** tenant's `region` attribute pins all of that
  tenant's stores (Aurora, S3, vector, graph, audio) to its region. Route 53
  geolocation routes EU users to the EU stack. **No EU PII crosses to US.** The
  control plane (auth, billing) is global but stores only non-residency-sensitive
  metadata, or is regionalized for strict tenants.
- **Cross-region for LLM:** if Claude API region availability requires US calls
  for EU data, that is gated by Team 9 (DPA/SCCs + redaction) — EU-resident
  enterprise tenants get the **self-host LLM tier in-region** to avoid the
  transfer entirely.
- **At North-star:** US goes **active-active** (us-east-1 + us-west-2) behind
  Global Accelerator with per-session affinity; EU remains a residency island.

---

## 10. Disaster Recovery (RPO/RTO, backups, failover)

### 10.1 Targets

| Tier | Data | RPO | RTO | Strategy |
|---|---|---|---|---|
| **Tier 0 — control plane** (auth, tenant, billing, consent ledger) | Aurora Global DB | **≤ 1 min** | **≤ 15 min** | Aurora Global Database cross-region replica; promote on failover |
| **Tier 1 — durable artifacts** (transcripts, cards, graphs) | Aurora + S3 CRR | **≤ 5 min** | **≤ 30 min** | S3 Cross-Region Replication; Aurora replica |
| **Tier 2 — analytics/data lake** | S3 | **≤ 24 h** | **≤ 4 h** | Async replication / re-derive |
| **Live in-flight sessions** | MSK/Kinesis + Redis | **best-effort** | reconnect | Sessions are ephemeral; clients auto-reconnect and resume from last `seq`; no hard RPO on live audio |

### 10.2 Backups

- **Aurora:** continuous PITR (35-day window) + automated snapshots; **Global
  Database** for cross-region.
- **S3:** versioning + **CRR** to us-west-2 (and eu-central-1 stays in EU);
  Object Lock for audit/audio under legal hold.
- **DynamoDB:** PITR + on-demand backups.
- **Config/IaC:** everything is **Terraform/CDK in Git**; the platform is
  reproducible from code — infra is itself "backed up" as code.
- **Backup restore is tested quarterly** (game day) and is a compliance control
  for SOC 2 (Team 9).

### 10.3 Failover

- **DR posture = warm standby** (MVP/Year-1): minimal always-on footprint in
  us-west-2 (Aurora replica, S3 CRR, IaC ready), scaled up on failover via
  Route 53 health-check + ASG/Karpenter scale-out. Targets RTO ≤ 30 min.
- **North-star = active-active US** → near-zero RTO for US.
- **Runbooks** automated via Step Functions where possible; failover is a tested
  game-day procedure, not a manual scramble.

---

## 11. Infrastructure diagram (deployment, primary region)

```
                         Internet
                            │
                 ┌──────────▼───────────┐
                 │ Route 53 (geo/latency)│
                 └──────────┬───────────┘
        ┌───────────────────┼───────────────────────┐
        │                   │                        │
 ┌──────▼──────┐   ┌────────▼─────────┐     ┌────────▼─────────┐
 │ CloudFront  │   │ Global Accelerator│     │  ACM / WAF /     │
 │ (static+API)│   │ (WebRTC audio)    │     │  Shield Adv      │
 └──────┬──────┘   └────────┬─────────┘     └──────────────────┘
        └─────────┬─────────┘
            ┌──────▼───────┐  (Public subnets, 3 AZ)
            │  ALB (HTTPS/  │
            │   WSS)        │
            └──────┬────────┘
   ┌───────────────▼───────────────────────────┐  (Private-app subnets, 3 AZ)
   │  ECS Fargate: Gateway · Extraction ·       │
   │  Explanation · Research · Orchestration    │
   └───────┬───────────────────────┬───────────┘
           │ produce/consume        │ model calls (NAT/PrivateLink)
   ┌───────▼─────────────┐   ┌──────▼─────────────────────────────┐
   │ MSK / Kinesis (3 AZ)│   │ Anthropic Claude · STT vendor ·     │
   │ per-session topics  │   │ web-search  (egress, DPA-governed)  │
   └───────┬─────────────┘   └─────────────────────────────────────┘
           │ consume (STT GPU)
   ┌───────▼──────────────┐ (Private-gpu subnets)
   │ EKS GPU (Karpenter)  │ self-host STT / open-weight LLM
   └───────┬──────────────┘
   ┌───────▼──────────────────────────────────────────────┐ (Private-data, 3 AZ)
   │ Aurora PG (Global DB) · ElastiCache Redis ·           │
   │ OpenSearch/Pinecone · Neptune · DynamoDB              │
   └───────┬───────────────────────────────────────────────┘
           │
   ┌───────▼─────────────────────────────┐
   │ S3 (SSE-KMS): audio* / artifacts /   │  *audio only if retention ON
   │ data-lake   +  CRR → us-west-2 / EU  │
   └──────────────────────────────────────┘

 Cross-cutting: KMS (CMKs) · Secrets Manager · IAM (least-priv) ·
 CloudWatch/AMP/X-Ray/Grafana · CloudTrail (→ Team 9 audit) ·
 Terraform/CDK IaC · DR replica stack in us-west-2 (warm standby)
```

---

## D12 required sections

### Architecture
See §1–§7, §11. Event-streaming spine (MSK/Kinesis) with stateless Fargate
services, EKS GPU for self-host inference, Aurora/Redis/vector/graph/S3/DynamoDB
state, CloudFront/Global Accelerator edge, full OTel observability.

### Technology recommendations
ECS Fargate (hot path) · EKS+Karpenter+GPU (self-host STT/LLM) · Amazon MSK
(Kafka) + Kinesis (MVP) + SQS/EventBridge/Step Functions · Aurora PostgreSQL +
pgvector → OpenSearch/Pinecone + Neptune · ElastiCache Redis · DynamoDB · S3 ·
CloudFront + Global Accelerator + WAF + Shield + Route 53 · CloudWatch + AMP +
X-Ray + Managed Grafana + OTel · Terraform/CDK IaC · KMS/Secrets Manager.

### Risks
| Risk | Sev | Mitigation |
|---|---|---|
| Inference cost runaway | High | Model tiering, caching, token caps, self-host at scale, per-session cost SLO + Budgets |
| MSK ops complexity | Med | Start on Kinesis; abstract behind EventBus iface; managed MSK; runbooks |
| GPU capacity/availability | Med | Multi-instance-family, Spot+On-Demand mix, hosted STT fallback |
| Hot-path cold starts | High→Low | No Lambda on hot path; warm Fargate pools |
| Multi-region data leakage (residency) | High | Region-pinned stores per tenant; geo DNS; self-host LLM in-region for EU |
| Single-region outage | Med | Warm standby DR (→active-active at NS); tested game days |
| Vendor lock (Claude/STT) | Med | Bedrock + open-weight self-host tier; abstraction layer |

### Scalability
Stateless services scale on consumer lag/active-session metrics; MSK partitions
sized for 2× peak concurrency; Aurora Serverless v2 → provisioned + replicas;
pgvector → dedicated vector DB; Postgres-graph → Neptune; Kinesis → MSK. Validated
at the three D02 points in §8.2 (200 → 5,000 → 50,000 concurrent).

### Security
Owned by Team 9. Platform provides the substrate: private subnets, SGs/NACLs,
VPC endpoints/PrivateLink, KMS SSE everywhere, Secrets Manager, IAM least-priv,
WAF/Shield, CloudTrail feeding the audit pipeline, RLS-based tenant isolation,
silo option for enterprise/HIPAA.

### Cost
Full model in §8.2: ~$8k/mo (MVP) → ~$390k/mo (Year-1) → ~$3.75M/mo (North-star);
cost-per-session-hr $2.00 → $0.98 → $0.47. Inference dominates; levers in §8.1.

### MVP scope
Single region us-east-1, multi-AZ. Fargate everything; **Kinesis** (not MSK);
hosted STT; **Aurora Serverless v2 with pgvector** (no separate vector/graph DB);
Redis; S3; CloudWatch + basic X-Ray; warm-standby DR optional/manual. Defer EKS
GPU, Neptune, dedicated vector DB, Shield Adv, second region until Year-1 triggers.

### Future enhancements
Active-active multi-region; cell-based architecture for blast-radius isolation;
service mesh (App Mesh/Istio) + mTLS; self-hosted inference fleet with
Trainium/Inferentia for cost; per-tenant cost showback portal; FinOps automation;
chaos engineering program; edge inference for ultra-low-latency partial cards.

### Assumptions
A-PLAT-1 avg session 30 min, ~8 sessions/MAU/mo (D02-derived) · A-PLAT-2 ~1 MB/min
audio compressed · A-PLAT-3 inference is 70–85% of cost · A-PLAT-4 hosted STT at
MVP, self-host economical by Year-1+ · A-PLAT-5 EU residency demand emerges at
Year-1 (drives eu-central-1).

### Decisions
**D-PLAT-01** hot path = Fargate containers, serverless only off-path, GPU = EKS ·
**D08 final** = MSK at scale, Kinesis at MVP, behind EventBus abstraction (§4) ·
**D09 final** = Aurora+pgvector→OpenSearch/Pinecone, PG-graph→Neptune, Redis, S3,
**+DynamoDB** (§5) · **D-PLAT-02** DR = warm standby → active-active US at NS ·
**D-PLAT-03** residency by tenant region-pinning + geo DNS.

### Tradeoffs
Kinesis (simple/cheap MVP) vs MSK (powerful/cheaper-at-scale) → phase the swap ·
Pooled multi-tenant (cheap) vs silo (isolated, compliant, costly) → offer both ·
Hosted inference (fast to ship) vs self-host (cheaper + residency, ops heavy) →
hosted MVP, self-host at scale · Warm standby (cheap, RTO 30 min) vs active-active
(near-zero RTO, 2× cost) → phase by scale.

### Open questions
OQ-PLAT-1 Bedrock-hosted Claude vs Anthropic API direct — affects residency/BAA
(coordinate w/ Team 9 + F02). OQ-PLAT-2 exact self-host STT model (Whisper vs
Parakeet) GPU sizing — owned by F01, platform provisions. OQ-PLAT-3 do we need
active-active before North-star for an enterprise SLA? OQ-PLAT-4 Pinecone (SaaS,
faster) vs OpenSearch (in-VPC, residency-clean) for vector at scale.

### Estimated complexity
**High.** Real-time + GPU + multi-region + multi-tenant + event-streaming +
compliance substrate. Largest ongoing-ops surface of any lane. MVP is achievable
by ~2–3 platform engineers; Year-1 needs a dedicated 4–6 person platform/SRE team.
