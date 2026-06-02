# Aizen — Architecture Decisions (canonical, in-tree)

> **This is the authoritative, version-controlled decisions ledger** that docs
> 01–13 in this directory reference by name. It was promoted from the ClaudeTrees
> run ledger (`.claudetrees/…/DECISIONS.md`, which is gitignored tooling scratch)
> so the decisions the committed docs depend on live on tracked ground.
>
> These are the shared conventions every lane (F01–F05) must honor so the system
> integrates without conflict. Dated log; newest at the bottom. The user may
> override any decision.

## 2026-05-31 — Run-wide shared conventions (D01–D12)

- **D01 — Product name & framing.** Working name **Aizen**: a real-time
  conversation intelligence copilot that transcribes, explains, and teaches any
  live conversation. Tagline: "AI explains the room."

- **D02 — Primary scale target (for all scalability/cost math).** Design to
  these reference points so every lane sizes against the same numbers:
  - MVP: 1,000 MAU, ~200 concurrent live sessions, avg session 30 min.
  - Year-1 scale: 100,000 MAU, ~5,000 concurrent sessions peak.
  - North-star: 2,000,000 MAU, ~50,000 concurrent sessions peak, global.

- **D03 — Default cloud = Azure.** Primary region eastus, zone-redundant; second
  region westus for DR; westeurope for EU data residency at scale. Lanes
  may note AWS/GCP equivalents but cost/scale math uses Azure.

- **D04 — LLM strategy.** Anthropic **Claude** family is the primary reasoning/
  explanation model (Opus-class for deep explanation, Sonnet-class for the
  real-time hot path, Haiku-class for cheap classification/routing). Open-weight
  models (e.g. Llama-class) considered for self-host/enterprise and cost control.
  Embeddings: a hosted embedding model with an open-weight fallback. State model
  *tiers/roles*, not just one model.

- **D05 — Speech-to-text.** Streaming STT as the real-time hot path; lanes
  evaluate hosted (Deepgram / AssemblyAI / Azure / Google) vs self-hosted
  (Whisper-class / Parakeet-class) and recommend with a tradeoff table. Diarization
  is owned by the transcription lane.

- **D06 — Canonical data contracts (names are fixed; F01 owns the authoritative
  schema definition, others reference by name only):**
  - `AudioFrame` — a timestamped chunk of captured audio + session/speaker meta.
  - `TranscriptSegment` — speaker-attributed, timestamped, confidence-scored text
    span; the atomic unit flowing downstream. **This is the integration seam
    between F01 and F02.**
  - `ConceptCard` — an extracted concept/entity/acronym with its explanation,
    examples, citations, and graph links (F02 owns; F03 renders).
  - `KnowledgeGraphNode` / `KnowledgeGraphEdge` — the conversation knowledge graph
    (F02 owns the schema; F03 visualizes).
  - `InsightItem` — action item / decision / open question (F02 owns; F03 renders).
  All inter-service messages carry `session_id`, `tenant_id`, `seq`, and
  monotonically increasing timestamps.

- **D07 — Latency budget (end to end, speech → first useful UI).** Total target
  p50 ≤ 3 s, p95 ≤ 5 s, split as a budget every lane must fit inside:
  capture+stream ≤ 500 ms · STT partial ≤ 800 ms · extraction ≤ 700 ms ·
  explanation first-token ≤ 1,000 ms · render ≤ 300 ms. Deep/research-grade
  explanations stream in afterward (best-effort, ≤ 10 s).
  > **⚠ Rebuilt by D17 / doc 12 (2026-06-01).** This per-stage split does not sum
  > to 3 s (= 3300 ms) and omits the EventBus hops, provider RTT, and cache-miss;
  > it also chains off the partial while the design extracts on finals. See the
  > rebuilt p50+p95 budget and the speculative-on-partial trigger in
  > `12-latency-budget.md`. The 3 s/5 s *targets* stand; the *split* is superseded.

- **D08 — Event backbone.** Treat the pipeline as an event-streaming system.
  Default to a managed log/stream (Kafka-class; Azure Event Hubs or a Kafka surface) plus
  WebSocket/WebRTC at the edge. F08 (platform) owns the authoritative choice;
  other lanes assume a durable ordered per-session stream exists. *(Concretized by
  D13.)*

- **D09 — Datastores (defaults; F08/platform owns final word).** Postgres for
  relational/transactional, a vector store for embeddings (pgvector at MVP →
  dedicated vector DB at scale), a graph store for the knowledge graph
  (Postgres-backed adjacency at MVP → Neo4j-class at scale), object storage (Azure Blob)
  for audio/artifacts, Redis for cache/session state. *(Refined by D14.)*

- **D10 — Privacy & consent are first-class, not bolted on.** Two-party-consent
  recording laws apply; the platform must support per-session consent capture,
  configurable retention, encryption in transit and at rest, and a
  no-audio-retention mode. F09 owns the authoritative model; every lane flags
  PII/consent touchpoints it creates.
  > **⚠ Re-modeled by D18–D20 / doc 13 (2026-06-01).** "Per-session consent
  > capture" is a per-speaker legal exposure; consent is re-modeled as a
  > per-speaker predicate (D18), the meeting-bot is jurisdiction-gated (D19), and
  > the INV-6 PII gate is made fail-closed with a named classifier (D20).

- **D11 — Platforms.** Web app (primary), desktop (Electron/Tauri-class for
  system-audio capture), mobile (iOS/Android). A thin real-time client + heavy
  server-side AI. F06 (UX) and F01 (capture) coordinate the client surface;
  server is authoritative.

- **D12 — Deliverable structure (every lane, every team it owns).** Each team's
  doc MUST contain these sections: Architecture · Technology recommendations ·
  Risks · Scalability · Security · Cost · MVP scope · Future enhancements ·
  Assumptions · Decisions · Tradeoffs · Open questions · Estimated complexity.
  Use markdown tables and ASCII/Mermaid diagrams. Be concrete: name technologies,
  give latency/throughput/cost numbers tied to D02, and state why.

## Team → lane mapping (so "teams must not overlap" is enforced)

| Lane | Owns teams | Domain |
|---|---|---|
| F01 | 1 Audio Capture & Streaming · 2 Speech Recognition & Speaker ID | Ingest → transcript |
| F02 | 3 Knowledge Extraction · 4 AI Explanation · 5 Research & Context Retrieval | Conversation intelligence (the AI core) |
| F03 | 6 User Experience · 7 AI Agent Orchestration | Experience + multi-agent system |
| F04 | 8 Infrastructure & Platform · 9 Security, Privacy & Compliance | Production platform + legal-to-deploy |
| F05 | 10 Product Strategy | Business, market, MVP, roadmap |

Final integration (unified/MVP/scaling architecture, phased plan, staffing, risk
assessment, executive summary) is **conductor-owned**, not a lane.

## 2026-05-31 — Integration-phase decisions (D13–D16, conductor)

Propagated after reviewing all five lanes' RESULT.md + docs.

- **D13 — Event backbone confirmed (supersedes the D08 default's ambiguity).**
  Per F04: **Azure Event Hubs at MVP → a Kafka-compatible log (Event Hubs Dedicated
  / MSK-class) at Year-1**, both behind a thin `EventBus` abstraction partitioned by
  `session_id`; Service Bus + Event Grid + Durable Functions for control-plane/async.
  Guarantee other lanes rely on is unchanged: a durable, ordered, replayable,
  per-`session_id` stream with idempotent at-least-once consumers keyed on
  `(session_id, seq)`. F02/F03's ordering assumptions hold. The `EventBus` exposes an
  opaque `Position` token (Event Hubs offset / Kafka offset) — see doc 10 §0.

- **D14 — Datastores confirmed + one addition (refines D09).** All D09 defaults
  kept (PostgreSQL Flexible Server + pgvector → dedicated vector DB at scale; Postgres-graph
  → a managed graph DB at scale; Redis; Blob). **Added: Cosmos DB** for idempotency/
  dedup keys and append-only audit — additive, no behavior change for other lanes.

- **D15 — LLM gateway ownership resolved (F03 OQ / F04 OQ).** **F04 (platform)
  owns the LLM gateway** — a shared service doing model routing, prompt-cache
  management, provider fallback, cost accounting, and per-tenant/per-tier rate
  limiting + cost-ceiling enforcement. **F03/F07 orchestration consumes it** and
  does NOT call providers directly. Free-tier Haiku-only routing and per-tier
  minute caps (F05 requirement) are enforced at this gateway. Secrets live only
  in the F04 secret store (Azure Key Vault).

- **D16 — IR-1 resolved: F01↔F02 transcript seam.** F01's `TranscriptSegment`
  (authoritative) is the contract; F02 adapts at its extraction ingress. The
  required field map (no F01 or F02 redesign):
  | F02 internal expectation | F01 authoritative field | Adapter action |
  |---|---|---|
  | `t_start` / `t_end` (µs) | `start_ms` / `end_ms` (ms, media clock) | ×1000; keep media-clock semantics; use `emitted_at` only for latency telem. |
  | `speaker_id` | `speaker.speaker_id` | unwrap nested object |
  | `speaker_label` | `speaker.display_name` | unwrap; honor later F03 renames via supersede |
  | `lang` | `language` (BCP-47) | rename |
  | `segment_id` (assumed UUID) | `segment_id` = `{session}:seg:{seq}` (string) | treat as opaque string, not UUID |
  F02 extracts on `is_final=true`, dedups on `(segment_id, rev)`, handles
  `supersedes` corrections. Open contract questions DC-3 (expose n-best lattice
  to F02?) deferred to post-MVP; MVP uses top-1 + `alt`.

## 2026-06-01 — Blueprint-validation remediation decisions (D17–D20, INV-8/9, conductor)

Propagated from the adversarial validation review (`09-validation-review.md`) and
its four remediation docs (10 seam contracts · 11 cost model · 12 latency budget ·
13 consent & privacy). These **refine or supersede** earlier defaults where the
detailed design changed them; each cites its source doc.

- **D16 amendment (doc 10, Seam A — closes H-7/H-8).** The F01→F02 adapter MUST
  also pass through **`rev` and `supersedes`** (the prior field map silently
  dropped them, breaking correction semantics). The adapter is pure/stateless and
  takes a second input, **`ConsentContext`** (see D20), from which it stamps
  `consent_class`/`pii_present` **fail-closed** (missing ⇒ `sensitive` +
  `pii_present=true`). "F02 handles `supersedes`" is now a real contract, not an
  assertion: F02 maintains a per-session provenance index and **re-extracts or
  retracts** artifacts citing a superseded segment.

- **INV-8 — no live citation of superseded text (doc 10, Seam B).** Within a
  supersede-propagation budget (≤ 2 s p95 from arrival), no non-`retracted`
  `ConceptCard`/`KG`/`InsightItem` may carry a superseded `segment_id` in its live
  provenance. Adds a `retracted` state + `retraction{}` to `ConceptCard` (additive,
  v1 minor) so F03 can un-render; KG retracts via `kg_delta.remove_*_ids`.
  `kg_delta` resync gains a `kg_snapshot` schema, a `kg_resync_request` schema, and
  a per-session **`delta_seq`↔bus-`Position` index** (closes the C-7 prose arrow).

- **D17 — extraction trigger = speculative-on-stabilized-partial, reconciled on
  final (doc 12 — closes H-2; reverses MVP §5 "extract on finals only").** The
  committed hot path triggers extraction on a stabilized, high-confidence partial
  (≥300 ms unchanged, salience-gated), and reconciles when the final arrives (via
  the INV-8 supersede/retract flow). Finals-only becomes the **fallback/degraded
  mode**. Rationale: measured from when the concept word is *spoken*, finals-only
  is ~4.6 s p50 / 9.3 s p95 and **fails** the wedge metric; speculative is
  ~1.8 s/3.4 s and meets D07. Cost: bounded card churn (absorbed by INV-8). The
  **salience+stability gate is the shared control point for both latency and the
  cost model's `enrichments/min` lever.** D07's per-stage table is rebuilt with
  p50+p95 columns, explicit Event Hubs-hop (×2) and provider-RTT lines, and
  layered prompt-cache breakpoints; SLOs are re-keyed to `t_word` (spoken), not
  `t_uend` (utterance-end).

- **D18 — consent is per-speaker; all-party capture requires per-track audio else
  blocks (doc 13 — closes H-10; supersedes team-09 §3.3 session-scalar model).**
  Consent is held per `(session, speaker_id)` with a continuously-evaluated
  `may_capture()` predicate. New-speaker detection (F01 diarization) wires to a
  consent re-check on `control.session`. Per-speaker revocation stops that speaker
  without killing the session. In **all-party** jurisdictions, if any detected
  speaker is unconsented, capture continues only on **per-track** topologies
  (masking that track) and otherwise **blocks the mixed stream** (you cannot
  surgically remove one voice from a mix). Prior third-party disclosure is
  irreversible; revocation is prospective.

- **D19 — meeting-bot gated to single-party jurisdictions at MVP (doc 13 — closes
  H-11).** Audible disclosure ≠ affirmative consent in all-party states, and host
  "enabling" never consents for others. The bot runs in all-party jurisdictions
  **only** with (a) per-track capture and (b) platform-native or interstitial
  affirmative consent per participant. Host attestation is recorded but never
  transferable. Disclosure badges split into `no_audio_retention` /
  `processing_disclosure` (names sub-processor, e.g. Deepgram, under DPA) /
  `no_third_party_disclosure` (self-host only); consent text must match the actual
  `disclosure_scope`. Regulated/C4/all-party-strict tenants default to **self-host
  STT**.

- **D20 — INV-6 PII gate is fail-closed with a named classifier + recall targets
  (doc 13 — closes H-13; supersedes the assume-`consent_class`-is-set posture).**
  Two OR-combined signals: `consent_class` (from F04 consent context, by tenant
  vertical/jurisdiction) and `pii_present` (from a layered PII/PHI classifier —
  deterministic recognizers + NER + Azure AI Language for health/in-VNet). Runs on the deep
  (≤10 s) path, not the ≤1 s enrich path. **Recall ≥ 0.95 PII / ≥ 0.98 PHI**
  (recall over precision; over-suppression is the safe error). Missing/errored/
  timed-out ⇒ `pii_present=true` (fail-closed; same rule as the D16 adapter).
  Classifier + labeled eval set are a Phase-0/1 deliverable.

- **INV-9 — the cross-session evidence cache holds no personal data (doc 13 —
  closes M-9).** The shared web/evidence cache (keyed by `canonical_name+domain`,
  reused cross-tenant) stores only generic C1/T2–T3 reference content; no C3/C4,
  transcript-derived (T1), or tenant-internal-doc content is ever shared-cached
  (those stay tenant-scoped, reachable by the DSAR cascade). The cache write path
  runs the D20 classifier; keys never contain a raw PII-bearing query. This makes
  the shared cache DSAR-exempt by construction and prevents a PII false-negative
  from leaking into un-erasable shared storage.

> **Cost-model note (doc 11 — RISK-1).** Not a new convention, but the binding
> planning correction: rebuilt bottom-up, MVP unit cost is **~$3.5/session-hr**
> (not $2.00; infra dominates at MVP, LLM at scale), realistic Pro margin at
> documented usage is **negative-to-thin** (not 65% — that is a Year-1 target),
> the self-host STT crossover lands at **~8–12k session-hrs/mo (early Year-1)**,
> Pro needs a **bounded hour pool + a $3/hr overage** (currently unset), and the
> land-grab must be funded to **~$5–8M**. Cost dashboard is a P0 feature.

**Still pending (manual/legal, not design):** state-by-state consent matrix
(OQ-SEC-3), sub-processor DPAs/BAAs + STT zero-retention contract (OQ-SEC-1/2),
negotiated Anthropic/Deepgram rate cards (MAN-F05-002), PII eval-set construction,
DPIA. The architecture is now parameterized to accept these answers without rework.
