# 02 — Conversational Intelligence Core (F02)

> The **AI brain** of Aizen ("AI explains the room"). Consumes
> `TranscriptSegment` (from F01, by name only) and produces understanding:
> `ConceptCard`s, a live `KnowledgeGraph`, and `InsightItem`s — explained,
> sourced, and grounded. Honors `DECISIONS.md` D01–D12; this lane owns the
> authoritative schemas in `data-contracts.md` (the **F02 → F03 seam**).

## Teams in this lane

| Team | Doc | Owns |
|---|---|---|
| **3 — Knowledge Extraction** | [`team-03-knowledge-extraction.md`](team-03-knowledge-extraction.md) | Topic/concept/acronym/entity/relationship extraction, segmentation, semantic indexing, incremental knowledge-graph build. The **hot path** (≤700 ms). |
| **4 — AI Explanation Engine** | [`team-04-explanation-engine.md`](team-04-explanation-engine.md) | Plain-language explanation, jargon simplification, examples/analogies/definitions, surfaced assumptions/hidden context, historical context, referenced tech. Prompting + context-management + anti-hallucination. Streams enriched (≤1000 ms first token) → deep (≤10 s). |
| **5 — Research & Context Retrieval** | [`team-05-research-retrieval.md`](team-05-research-retrieval.md) | Hybrid RAG, web search, internal-doc search, citation model, fact verification, source ranking, context enrichment. The **evidence layer**. |
| (contracts) | [`data-contracts.md`](data-contracts.md) | Authoritative `ConceptCard`, `KnowledgeGraphNode/Edge`, `InsightItem`, `kg_delta`. |

## End-to-end dataflow

```
F01                       ┌──────────────────── F02 (this lane) ────────────────────┐                  F03
TranscriptSegment ───────▶│ T3 Extraction (Haiku, ≤700ms)                            │
(is_final, by name)       │   ├─ skeleton ConceptCard ───────────────────────────────┼──▶ render chip
                          │   ├─ kg_delta (nodes/edges) ─────────────────────────────┼──▶ graph viz
                          │   └─ InsightItem (action/decision/question) ─────────────┼──▶ insights panel
                          │        │                                                  │
                          │        ▼                                                  │
                          │ T4 Explanation                                            │
                          │   ├─ Pass A enrich (Sonnet, first-token ≤1000ms) ─────────┼──▶ card body
                          │   │     uses session context only                         │
                          │   └─ Pass B deep (Opus, ≤10s) ◀── evidence ── T5 ──────────┼──▶ deep dive
                          │        │ grounding gate (anti-hallucination)              │
                          │        ▼                                                  │
                          │ T5 Research/RAG (web + internal + curated + session)      │
                          │   └─ ranked, trust-tiered, NLI-verified Citation[] ───────┼──▶ sources
                          └───────────────────────────────────────────────────────────┘
```

## Model tiers (D04) by role

| Role | Tier | Where |
|---|---|---|
| Extraction, query planning, self-check, summarizer, bulk verification | **Haiku** (cheap/routing) | T3, T5, T4 micro-decisions |
| Real-time explanation (enrich), verification adjudication | **Sonnet** (hot path) | T4 Pass A, T5 escalation |
| Deep explanation over verified evidence | **Opus** (deep) | T4 Pass B |
| Embeddings | hosted + open-weight fallback | T3 index, T5 retrieval |
| Self-host/enterprise/residency | open-weight (Llama-class) behind same contracts | all tiers |

## Latency budget conformance (D07)

| Stage | D07 budget | F02 design | Tier |
|---|---|---|---|
| Extraction → skeleton card + graph delta | ≤700 ms | two-stage lexical/embedding + constrained Haiku, p95 ≈ 680 ms | Haiku |
| Explanation first token (enrich) | ≤1000 ms | Sonnet streaming, prompt-cached prefix, bounded context | Sonnet |
| Deep explanation (research-grade) | ≤10 s best-effort | Opus over time-boxed RAG; timeout → "deep pending" | Opus + RAG |

## Scale conformance (D02)

Sized in each team doc against MVP (200 concurrent), Year-1 (5,000), North-star
(50,000). Key scalers: Haiku on the hot path; prompt caching + **cross-session
explanation cache**; **cache-first web** + cross-session evidence cache; delta
(not snapshot) graph updates; stateless workers keyed by `session_id`; regional
indices (D03).

## Privacy & consent (D10)

Every contract carries `consent_class` + `pii_present`. **INV-6**: sensitive/PII
concepts never trigger external web/internal retrieval — the privacy gate in T5
query planning enforces it; deep explanation degrades gracefully with a visible
"no external sources (privacy)" note. F02 sees text/derived data only (supports
no-audio-retention mode). F09 owns the authoritative privacy model; F02 flags
every touchpoint.

## Anti-hallucination (the product's trust spine)

Evidence-only prompting → constrained output → Haiku self-check → NLI per-claim
verification → citation requirement (INV-1/2) → `verification_state`
(verified/contested/refuted) surfaced to the UI. Analogies labeled; parametric
claims marked; insufficient evidence yields a short grounded card, never invented
depth.

## Boundaries (what F02 does NOT do)

- **Runtime multi-agent orchestration** (how these capabilities are wired,
  routed, recovered at runtime) → **F03 / Team 7**. F02 designs *capabilities*
  and their contracts.
- **UI / rendering** of cards, graph, insights → **F03 / Team 6**.
- **Hosting, vector-DB/graph-DB provisioning, event backbone** → **F04** (D08/D09).
- **Audio/STT/diarization** → **F01**.

## Integration seam

- **Consumes:** `TranscriptSegment` (F01) — by name only; assumptions in
  `data-contracts.md` §1, tracked as integration risk IR-1.
- **Produces (authoritative):** `ConceptCard`, `KnowledgeGraphNode`,
  `KnowledgeGraphEdge`, `kg_delta`, `InsightItem` — F03 renders by name.

## Manual tasks

See `NEEDS_USER.md` / `MANUAL.md`: web-search vendor account (MAN-F02-001),
embedding/vector vendor (MAN-F02-002), acronym/reference-KB sourcing
(MAN-F02-003), licensed domain corpora (MAN-F02-004), Anthropic API
access/quota (MAN-F02-005).
