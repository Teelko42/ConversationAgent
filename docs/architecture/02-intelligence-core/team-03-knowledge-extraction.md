# Team 03 — Knowledge Extraction

> Lane **F02 / Conversational Intelligence Core**. Turns `TranscriptSegment`s
> (from F01, by name only) into `ConceptCard` skeletons, `KnowledgeGraphNode/Edge`
> deltas, and `InsightItem`s — the structured understanding of the conversation.
> Honors DECISIONS D02 (scale), D04 (LLM tiers), D06 (contracts), D07 (latency),
> D10 (privacy). Authoritative schemas: see `data-contracts.md`.

This team owns the **fast hot path** of the AI core: it must turn a finalized
transcript span into extracted structure within the **D07 extraction budget of
≤700 ms**. It does NOT explain (Team 4) or retrieve external sources (Team 5);
it emits the skeletons and the graph those teams enrich.

---

## 1. Architecture

### 1.1 Position in the pipeline

```
F01                         F02 / Team 3 (this doc)                       F02 T4/T5      F03
┌──────────────┐   stream   ┌───────────────────────────────────────┐
│ Transcript   │  Transcript│  Ingress Adapter ── Segmentation        │
│ Pipeline     ├──Segment──▶│       │              (boundary detector) │
│ (speaker-    │  (is_final)│       ▼                                  │
│  attributed) │            │  Candidate Span Builder (windowing)      │
└──────────────┘            │       │                                  │
                            │       ▼                                  │
                            │  ┌─────────────────────────────────┐    │
                            │  │ EXTRACTION FAN-OUT (parallel)    │    │
                            │  │  • Topic detector                │    │
                            │  │  • Concept/jargon spotter        │    │
                            │  │  • Acronym detect + disambiguate │    │
                            │  │  • NER (domain-aware)            │    │
                            │  │  • Relationship extractor        │    │
                            │  │  • Insight extractor (AI/D/Q)    │    │
                            │  └─────────────────────────────────┘    │
                            │       │                                  │
                            │       ▼                                  │
                            │  Entity Resolution + Dedup (per session) │   ConceptCard
                            │       │                                  │   skeleton ──────▶ T4 explain
                            │       ▼                                  │   kg_delta ───────▶ F03 graph
                            │  Semantic Indexer (embeddings)           │   InsightItem ────▶ F03
                            │       │                                  │
                            │       ▼                                  │
                            │  Incremental KG Builder ── emit deltas   │
                            └───────────────────────────────────────┘
```

### 1.2 Two-stage extraction (latency-driven)

To fit ≤700 ms while still being accurate, extraction is a **fast lexical/embedding
pass + a constrained LLM pass**, not one big LLM call:

| Stage | What | Tech / D04 tier | Budget | Why |
|---|---|---|---|---|
| S0 Ingress | Adapt F01 `TranscriptSegment`, buffer, dedupe by `seq` | stateless service | ~5 ms | Decouple F02 from F01 schema (IR-1). |
| S1 Lexical pre-scan | Regex/gazetteer hits: acronyms (`[A-Z]{2,6}`), known terms, numbers/units, named-entity surface forms via FlashText/Aho-Corasick over a domain gazetteer | CPU, no LLM | ~15–40 ms | Cheap recall; gives the LLM candidate anchors, cuts tokens. |
| S2 Embedding pass | Embed the candidate span; ANN lookup against (a) session memory, (b) tenant glossary, (c) global concept index for dedup + novelty + same-as resolution | Embedding tier (D04) | ~40–80 ms | Dedup ("already a card"), novelty score, entity resolution. |
| S3 Constrained LLM extract | One **Haiku-tier** call over the windowed context with tool/JSON-schema-constrained output emitting candidate concepts/entities/relations/insights | **Haiku** (D04 routing tier) | ~300–500 ms | Disambiguation, relation typing, insight detection — needs reasoning but not depth. |
| S4 Resolve + emit | Merge S1–S3, entity-resolve, build/patch graph, emit skeleton `ConceptCard` + `kg_delta` + `InsightItem` | service + Redis | ~30–60 ms | Produce contracts. |

**Total p50 ≈ 450 ms, p95 ≈ 680 ms** — inside the 700 ms budget. Deep
enrichment (definitions, web sources) is explicitly **out of this budget** and is
Team 4/5's streaming job.

### 1.3 Conversation segmentation

Concepts are extracted per **semantic segment**, not per raw `TranscriptSegment`
(which is STT-sized, often a clause). The segmenter groups final segments into
**topical units** for coherent extraction and graph anchoring.

| Signal | Source | Weight |
|---|---|---|
| Embedding cosine drift between sliding windows | S2 embeddings | high — primary boundary signal |
| Long pause / turn gap | `t_end`→next `t_start` | medium |
| Speaker change after sustained turn | `speaker_id` | low–medium |
| Discourse markers ("moving on", "next", "so to summarize") | lexical | medium |
| Question→answer adjacency | insight extractor | grouping hint |

Algorithm: **online TextTiling-style** boundary detection over a 3–8 segment
sliding window; a boundary fires when smoothed cosine drift exceeds an adaptive
threshold. Segments stream, so the segmenter is **incremental & revisable**: it
may emit a provisional boundary and retract it (graph delta) if the next segments
reconnect the topic. Topic nodes are created at confirmed boundaries.

### 1.4 Extraction sub-tasks (detail)

| Sub-task | Method | Output → contract |
|---|---|---|
| **Topic detection** | Segmenter + Haiku label of the segment → topic node | `KnowledgeGraphNode{node_type:topic}` |
| **Concept / jargon spotting** | Gazetteer + embedding outlier ("rare/technical token") + Haiku confirm | `ConceptCard{kind:concept\|jargon_term}` skeleton |
| **Acronym detection + disambiguation** | Regex candidate → resolve via (1) in-conversation expansion ("RAG, retrieval-augmented generation"), (2) domain prior (finance "RAG"=Red/Amber/Green vs software=Retrieval-Augmented Generation), (3) embedding context match against acronym KB | `ConceptCard{kind:acronym, canonical_name}` |
| **NER (domain-aware)** | Base NER (people/org/loc) + domain heads: financial instruments/tickers, drug/condition names (medical), case/statute refs (legal), products/libraries (tech) | `ConceptCard{kind:entity_*}` + entity node |
| **Relationship mapping** | Haiku relation extraction over co-occurring entities/concepts in a segment, typed to the `relation` enum; speaker→concept `attributed_to` edges from `speaker_id` | `KnowledgeGraphEdge` |
| **Insight extraction** | Pattern + Haiku classifier: imperatives/commitments → `action_item`; "we decided/agreed" → `decision`; unanswered interrogatives → `open_question`; modal-risk language → `risk` | `InsightItem` |
| **Semantic indexing** | Embed each node + segment, upsert to vector store with `(tenant_id, session_id)` namespace | `embedding_ref` on nodes; powers T5 RAG |

### 1.5 Acronym disambiguation flow

```
"RAG"  ──▶ candidate (regex)
   │
   ├─ in-session expansion found within ±N segments? ──yes──▶ use it (conf 0.95)
   │
   ├─ tenant glossary hit?                            ──yes──▶ use it (conf 0.9)
   │
   └─ no ──▶ embed local context, ANN vs acronym-KB per session.domain
            ├─ top match score > 0.78 ──▶ accept (conf = score)
            └─ ambiguous ──▶ emit card with `canonical_name` = best guess
                              + alternatives in graph; Haiku tie-breaks using
                              conversation domain prior; mark salience low until
                              a later mention confirms.
```

### 1.6 Incremental knowledge-graph build

The graph is built **online, per session**, never recomputed. Each extraction
cycle produces a `kg_delta` (see `data-contracts.md` §4):

- **Upsert node**: new concept/entity/topic/insight/speaker. Speaker nodes are
  created once from F01 `speaker_id`.
- **Upsert edge**: typed relation with `evidence_segment_ids` provenance.
- **Entity resolution / `same_as`**: if S2 finds an existing node within cosine
  ≥ 0.9 and compatible type, merge (emit `remove_node_ids` + re-point edges).
- **Recency decay**: edge `weight` decays with a half-life (~10 min) so the graph
  foregrounds the live topic; decayed-out edges stay for history but rank low.
- **Gap recovery**: `delta_seq` lets F03 detect a missed delta and request a
  `snapshot_offer`.

Storage follows D09: **Postgres adjacency (`nodes`, `edges` tables) at MVP →
Neo4j-class at scale**; vectors in pgvector (MVP) → dedicated vector DB at scale.
F04 owns provisioning; this team owns the schema and access patterns.

---

## 2. Technology recommendations

| Concern | MVP choice | Scale choice | Why |
|---|---|---|---|
| Extraction reasoning | **Claude Haiku** (D04 cheap/routing tier), JSON-schema/tool-constrained | same + speculative batching | Fast, cheap, good enough for span-level extraction; reserve Sonnet/Opus for explanation. |
| Lexical spotting | FlashText / Aho-Corasick + domain gazetteers | same, sharded gazetteers per domain | Sub-millisecond recall, zero token cost. |
| Embeddings | Hosted embedding model (D04) | + open-weight fallback (e.g. BGE/E5-class) self-hosted for cost/residency | D04 mandates hosted-with-open-fallback. |
| Vector index | **pgvector** (D09 MVP) | dedicated vector DB (Pinecone/Qdrant/Milvus-class) | D09 trajectory. |
| Graph store | **Postgres adjacency** (D09 MVP) | **Neo4j-class** (D09 scale) | D09 trajectory; adjacency suffices at session scale. |
| Session working memory | **Redis** | Redis cluster | Hot per-session state, dedup keys, segment buffer. |
| NER | LLM-native (Haiku) + lightweight spaCy/GLiNER-class for cheap recall | + fine-tuned domain NER heads | Hybrid keeps latency + cost down. |
| Serving | Stateless extractor workers behind the event backbone (D08) | autoscaled by concurrent sessions | Horizontal scale on D02 numbers. |

Open-weight self-host (Llama-class) is the enterprise/residency fallback for the
extraction tier (D04), behind the same JSON contract.

---

## 3. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Extraction blows 700 ms under bursty speech | Med | High | Two-stage design; cap LLM context window; queue + shed to "skeleton-lite" (lexical only) under load; speculative prefetch on partials. |
| Acronym/entity misdisambiguation across domains | High | Med | Domain prior + in-session expansion + low initial salience; correct on later mentions (revision bump). |
| Over-extraction (too many low-value cards → noise) | High | Med | Salience + novelty gating; suppress cards below salience threshold; merge near-duplicates via S2. |
| Graph drift / unbounded growth in long sessions | Med | Med | Recency decay; cap live working-set; archive cold subgraph; emit deltas not snapshots. |
| F01 `TranscriptSegment` schema differs from assumption | Med | High | Ingress adapter isolates it (IR-1); contract test against F01's published schema. |
| PII leakage into external lookups via extracted entities | Med | High | `pii_present`/`consent_class` set at extraction; INV-6 blocks external retrieval (D10). |
| Hallucinated relations/entities | Med | Med | Constrained decoding (schema), evidence-required edges (INV-3/4), confidence floor. |

---

## 4. Scalability (against D02)

Assume each active session produces a finalized segment roughly every **3–6 s**
of speech → ~0.2 extraction cycles/s/session.

| Tier (D02) | Concurrent sessions | Extraction cycles/s | Haiku calls/s | Embedding calls/s | Notes |
|---|---|---|---|---|---|
| MVP | 200 | ~40 | ~40 | ~80 (span + node) | Single extractor service, few workers; pgvector. |
| Year-1 | 5,000 | ~1,000 | ~1,000 | ~2,000 | Autoscaled workers; dedicated vector DB; gazetteer cache warm. |
| North-star | 50,000 | ~10,000 | ~10,000 | ~20,000 | Sharded by `session_id`; regional (D03); batched embedding; Haiku throughput is the cost/capacity driver. |

Scaling levers: stateless workers keyed by `session_id` (sticky for session
memory locality), batch embeddings, cache gazetteer/glossary per tenant, shed to
lexical-only skeletons under extreme load (graceful degradation preserves the
700 ms SLO at the cost of richness).

---

## 5. Security

- **Tenant isolation:** every node/edge/vector namespaced by `(tenant_id,
  session_id)`; ANN queries scoped; no cross-tenant retrieval (INV-7).
- **PII/consent (D10):** extractor tags `pii_present`/`consent_class`; person
  names, financial/medical entities flagged sensitive; gates downstream external
  retrieval (INV-6). Honors no-audio-retention mode — F02 only sees text.
- **Prompt-injection from conversation content:** transcript text is untrusted
  input; the extractor uses **structured/tool-constrained output** and never
  executes instructions found in transcript text. Web content (T5) is likewise
  treated as data, not instructions.
- **At rest / in transit:** encryption owned by F04; F02 stores only derived
  structure + embeddings, retention-bound per session policy (D10).
- **Audit:** every emitted contract carries `trace_id`/`producer` for audit trail
  (F04/F09 consume).

---

## 6. Cost (illustrative, AWS + Claude per D03/D04)

Order-of-magnitude per the D02 tiers; treat as planning figures, not quotes.

| Item | Unit basis | MVP/mo (200 conc) | Year-1/mo (5k conc) |
|---|---|---|---|
| Haiku extraction calls | ~1 call/cycle, small ctx | ~40 calls/s · ~1.5k tok | ~1,000 calls/s |
| Embedding calls | ~2/cycle | bundled, low | scales linearly, biggest embed driver |
| Vector store | pgvector on existing PG (MVP) | ~$0 marginal | dedicated DB ($1–4k/mo class) |
| Graph store | PG adjacency (MVP) | ~$0 marginal | Neo4j-class cluster |
| Compute (workers) | stateless ECS/EKS | small | autoscaled |

**Cost control principle (D04):** keep the hot path on Haiku + embeddings; never
call Sonnet/Opus in the 700 ms extraction path — those are Team 4's streaming
budget. Extraction should be **<15% of F02 LLM spend**; explanation/research
dominate.

---

## 7. MVP scope

**In:** topic segmentation; concept/jargon spotting; acronym detection +
in-session/glossary disambiguation; NER (people/org/product + software & finance
domain heads); typed relation + `attributed_to` edges; insight extraction
(action items, decisions, open questions); incremental PG-backed graph; pgvector
semantic index; skeleton `ConceptCard` emit within 700 ms.

**Out (defer):** healthcare/legal domain NER heads; cross-session global concept
graph; advanced entity resolution beyond cosine `same_as`; multilingual
extraction (English-first per IDEA).

---

## 8. Future enhancements

- Cross-session / per-user **persistent knowledge graph** ("you discussed RAG
  last week").
- Fine-tuned/distilled extraction model to drop the Haiku call cost.
- Multilingual + code-switching extraction.
- Domain-pack marketplace (legal, clinical, sports) of gazetteers + NER heads.
- Active-learning loop: user corrections to cards feed gazetteer/glossary.
- Speaker-intent & sentiment as graph attributes.

---

## 9. Assumptions

- A01: F01 emits `TranscriptSegment` with the fields in `data-contracts.md` §1,
  including `is_final`, `speaker_id`, `t_start/t_end`, `confidence` (IR-1).
- A02: F02 extracts only on `is_final=true`; partials only drive speculative
  prefetch.
- A03: English-first (IDEA non-goal: no multilingual benchmarking this run).
- A04: Event backbone (D08) provides durable, ordered, per-session streams.
- A05: F03 (Team 7) owns *when/how* extraction is invoked at runtime; this team
  designs the *capability* and its contract, not the orchestration.

## 10. Decisions

- DE-1: Two-stage (lexical/embedding + constrained-Haiku) extraction, not a
  single large LLM call — required to hit 700 ms (honors D07/D04).
- DE-2: Skeleton `ConceptCard` is emitted by Team 3; enrichment is Team 4/5.
- DE-3: Graph emitted as **deltas** (`kg_delta`), never full snapshots, for
  latency + bandwidth (honors D02 scale).
- DE-4: Edges require `evidence_segment_ids` (INV-3/4) — no ungrounded relations.
- DE-5: Recency-decayed edge weights to keep the live graph focused.

## 11. Tradeoffs

| Choice | Gain | Cost |
|---|---|---|
| Haiku not Sonnet on hot path | Latency + cost | Lower extraction accuracy; mitigated by lexical pre-pass + later revisions. |
| Lexical-only degradation under load | Holds 700 ms SLO | Temporarily fewer/poorer concepts. |
| Delta graph vs snapshots | Bandwidth, incrementality | F03 must handle ordering/gap recovery. |
| Online revisable segmentation | Low latency | Occasional boundary retraction (UI churn). |
| PG adjacency at MVP | Simplicity, no new infra | Re-platform to Neo4j-class at scale. |

## 12. Open questions

- OQ-1: Final `TranscriptSegment` field names/types (await F01 `data-contracts.md`).
- OQ-2: Salience threshold for emitting a card — tune with real sessions.
- OQ-3: Should speaker nodes be per-session or resolved to persistent identities
  (privacy interplay with D10/F09)?
- OQ-4: Acronym-KB sourcing — build vs license (see MAN-F02-003).
- OQ-5: Graph recency half-life value — needs UX feedback from F03.

## 13. Estimated complexity

**High.** The hot-path latency budget, multi-domain disambiguation, online graph
maintenance, and entity resolution are each non-trivial; together they are the
hardest real-time piece of F02. Rough build: ~3–4 engineers, ~2 quarters to a
solid MVP extractor (segmentation + extraction + graph + index), with domain
heads added incrementally.
