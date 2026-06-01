# F04 — Platform, Security & Compliance

> Lane **F04** of the **Aizen** architecture blueprint ("AI explains the room").
> Owns user-brief **Team 8 (Infrastructure & Platform)** and **Team 9 (Security,
> Privacy & Compliance)** — the production platform everything runs on, and the
> controls that make it lawful and trustworthy to deploy.

## What this lane delivers

| Doc | Scope |
|---|---|
| [`team-08-infrastructure-platform.md`](./team-08-infrastructure-platform.md) | AWS cloud architecture (D03), compute (Fargate/EKS-GPU/serverless), storage, **event backbone (D08 final word)**, **databases + caching (D09 final word)**, CDN/edge, monitoring/observability + SLOs, cost optimization + cost model at all three D02 scale points, global-scale multi-region + data residency, disaster recovery (RPO/RTO), infrastructure diagrams. |
| [`team-09-security-privacy-compliance.md`](./team-09-security-privacy-compliance.md) | Security architecture, **STRIDE threat model**, consent management (two-party, per-session — D10), audio privacy + no-retention mode, encryption (TLS/AES/KMS/tenant isolation), retention + deletion, GDPR/CCPA, HIPAA, enterprise controls (SSO/SAML/SCIM/RBAC/IP-allowlist/audit), audit trails, compliance roadmap (SOC 2 Type II → HIPAA → GDPR/ISO). |

Both docs contain all **D12** sections (Architecture · Technology recommendations
· Risks · Scalability · Security · Cost · MVP scope · Future enhancements ·
Assumptions · Decisions · Tradeoffs · Open questions · Estimated complexity).

## How platform and compliance bind together

```
   Team 8 PLATFORM provides the substrate ───▶ Team 9 SECURITY uses it as controls
   ───────────────────────────────────────     ──────────────────────────────────
   Private VPC / SGs / PrivateLink          →   zero-trust network (no public data)
   KMS CMKs (per-tenant, per-region)        →   encryption + crypto tenant isolation
   RLS-capable Aurora + scoped Redis/S3     →   tenant data isolation (T6)
   CloudTrail / DynamoDB append / S3 WORM   →   immutable audit + consent ledger
   Realtime Gateway "consent gate" hook     →   no capture before consent (D-SEC-01)
   No-retention stream config (audio.raw=0) →   no-audio-retention default (D-SEC-02)
   Region-pinned stores + geo DNS           →   GDPR data residency
   Silo option (dedicated cluster + CMK)    →   HIPAA / enterprise isolation
```

The platform is designed *for* the compliance posture: the consent gate, the
no-retention default, per-tenant/per-region keys, and the silo option are
first-class platform features, not afterthoughts (honoring **D10**).

## Authoritative decisions this lane owns (for the conductor + other lanes)

- **D08 (event backbone) — CONFIRMED + refined:** Amazon **MSK (Kafka)** at scale,
  **Kinesis** at MVP, both behind a thin **EventBus** abstraction; SQS/EventBridge/
  Step Functions for control + async. Other lanes assume a **durable, ordered,
  replayable, per-`session_id` stream** addressed by logical topic name.
- **D09 (datastores) — CONFIRMED + refined:** Aurora PostgreSQL (+pgvector at MVP)
  → dedicated vector (OpenSearch/Pinecone) and graph (Neptune) at scale; Redis;
  S3; **plus DynamoDB** for idempotency/dedup/audit-append (additive, not a
  replacement).

See each team doc's **Decisions** section and the lane `NOTES.md` / `RESULT.md`
for the full rationale and any deltas the conductor must propagate.

## Boundaries

F04 **hosts and secures** the other lanes — it does **not** redesign F01 (capture/
STT), F02 (AI logic), or F03 (UX/orchestration). Cross-lane references are by name
only (`AudioFrame`, `TranscriptSegment`, `ConceptCard`, `KnowledgeGraph*`,
`InsightItem` per D06).
