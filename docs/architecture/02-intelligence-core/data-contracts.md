# F02 Data Contracts — `ConceptCard`, `KnowledgeGraphNode/Edge`, `InsightItem`

> **Authoritative.** Per `DECISIONS.md` D06, F02 owns these schemas. F03 renders
> them **by name only**; F01 owns `AudioFrame` / `TranscriptSegment` and F02
> consumes `TranscriptSegment` **by name only**. This file is the **F02 → F03
> integration seam**. Any change here is a contract change and must be announced
> on the bus.

Schema version: **`f02.contracts/v1`**. All schemas are versioned; the
`schema_version` envelope field gates compatibility. Wire format: JSON over the
event backbone (D08) and WebSocket to clients; Protobuf/Avro equivalents are
generated from these definitions at the platform layer (F04 owns serialization).

---

## 0. Shared envelope (every F02-emitted message)

Per D06, every inter-service message carries identity + ordering fields. F02
emits all four contracts wrapped in this envelope.

| Field | Type | Req | Notes |
|---|---|---|---|
| `schema_version` | string | yes | e.g. `"f02.contracts/v1"`. |
| `message_type` | enum | yes | `concept_card` \| `kg_node` \| `kg_edge` \| `insight_item` \| `kg_delta`. |
| `session_id` | UUID | yes | Live session. From D06. |
| `tenant_id` | UUID | yes | Multi-tenant isolation. From D06. |
| `seq` | uint64 | yes | Monotonic per-session sequence (ordering, dedupe). From D06. |
| `ts_emit` | int64 µs | yes | Monotonic emit timestamp (epoch µs). From D06. |
| `producer` | string | yes | Emitting service+version, e.g. `f02.extractor@1.4.2`. |
| `trace_id` | string | yes | W3C trace context for end-to-end latency attribution. |
| `payload` | object | yes | One of the contracts below. |

**Ordering & idempotency.** Consumers (F03) treat `(session_id, message_type,
payload.id, payload.revision)` as the idempotency key. Higher `revision`
supersedes lower for the same `id`. `seq` orders within a session.

---

## 1. `TranscriptSegment` (consumed, NOT owned — F01 authoritative)

F02 references this **by name only**. F02's hard assumptions about its shape (to
be confirmed against F01's `data-contracts.md`; tracked as integration risk
IR-1):

| Field F02 relies on | Assumed type | Use in F02 |
|---|---|---|
| `segment_id` | UUID | Provenance anchor in every `ConceptCard.sources` and graph node. |
| `session_id` / `tenant_id` | UUID | Envelope passthrough. |
| `seq` | uint64 | Ordering, windowing, replay. |
| `speaker_id` / `speaker_label` | string | Relationship subject, "who said it". |
| `text` | string | Extraction input. |
| `is_final` | bool | F02 extracts on `is_final=true`; partials drive speculative prefetch only. |
| `t_start` / `t_end` | int64 µs | Time-anchoring concepts onto the timeline. |
| `confidence` | float 0–1 | Down-weights low-confidence spans in extraction. |
| `lang` | BCP-47 | Routing; MVP English-first. |

> F02 **never mutates** `TranscriptSegment`. It only reads. If F01's final schema
> differs, the adapter at the extraction ingress (`team-03`) maps it; no other
> F02 code sees raw F01 fields.

---

## 2. `ConceptCard` (F02 owns)

The atomic unit of understanding: an extracted concept/entity/acronym plus its
explanation, examples, citations, and graph links. Streams to the client
incrementally (skeleton → enriched → deep) — see `state` and `revision`.

```jsonc
{
  "id": "cc_01HW...",                 // ULID, stable across revisions
  "revision": 3,                       // monotonic; higher supersedes
  "state": "enriched",                 // skeleton | enriched | deep | error
  "session_id": "uuid",
  "tenant_id": "uuid",

  "surface_form": "RAG",               // exact text as said/written
  "canonical_name": "Retrieval-Augmented Generation",
  "kind": "acronym",                   // see KIND enum below
  "domain": "software",                // finance|healthcare|legal|science|sports|business|software|general
  "salience": 0.82,                    // 0-1, importance in conversation (ranking for UI)
  "novelty": 0.91,                     // 0-1, how new to THIS session (dedupe-aware)

  "definition_short": "A technique that...",   // <=240 chars, always present at 'enriched'
  "explanation": {                     // null at 'skeleton', filled at 'enriched'/'deep'
    "plain_language": "markdown",
    "analogies": ["..."],
    "examples": ["..."],
    "assumptions_surfaced": ["Assumes the audience knows what an embedding is."],
    "hidden_context": ["The speaker is contrasting this with fine-tuning."],
    "historical_context": "markdown | null",   // 'deep' only
    "referenced_tech": [ { "name": "FAISS", "concept_card_ref": "cc_..." } ],
    "reading_level": "B1",             // CEFR target the explanation was written to
    "audience_profile": "general"      // general|practitioner|expert (from user setting)
  },

  "sources": [                         // see Citation model in team-05
    {
      "citation_id": "ct_...",
      "type": "transcript | web | internal_doc | model_parametric",
      "transcript_segment_ids": ["seg_..."],   // when type=transcript
      "url": "https://...",                     // when type=web
      "doc_id": "kb_...",                        // when type=internal_doc
      "title": "string",
      "snippet": "exact supporting quote",
      "retrieved_at": "iso8601",
      "trust_tier": "T1",              // T1..T4, see team-05 source ranking
      "support_score": 0.88            // entailment score grounding the claim
    }
  ],

  "graph_node_id": "kgn_...",          // links into the knowledge graph
  "related_concept_ids": ["cc_..."],   // sibling cards (graph neighbors, cached)

  "first_mention": { "segment_id": "seg_...", "t_start_us": 0, "speaker_id": "sp_2" },
  "mention_count": 4,
  "mention_segment_ids": ["seg_...", "..."],

  "grounding": {
    "grounded": true,                  // every non-parametric claim has >=1 citation
    "groundedness_score": 0.93,        // NLI-verified fraction of claims supported
    "verification_state": "verified",  // unverified|verified|contested|refuted
    "hallucination_flags": []          // claims that failed entailment, redacted from UI
  },

  "consent_class": "standard",         // standard|sensitive (D10): sensitive => no external retrieval
  "pii_present": false,                // flagged per D10; suppresses external lookup if true

  "model_provenance": {                // which D04 tier produced what
    "extractor_tier": "haiku",
    "explainer_tier": "sonnet",
    "deep_tier": "opus|null"
  },
  "created_at_us": 0,
  "updated_at_us": 0
}
```

**`kind` enum:** `topic | concept | acronym | entity_person | entity_org |
entity_product | entity_location | entity_financial_instrument |
entity_legal_ref | entity_medical | event | metric | jargon_term | reference`.

**Lifecycle / streaming states** (see `team-04` for budgets):

| `state` | Latency target | Contents | Model tier |
|---|---|---|---|
| `skeleton` | ≤700 ms (D07 extraction) | id, surface_form, canonical_name, kind, domain, salience | Haiku |
| `enriched` | first-token ≤1000 ms (D07) | + `definition_short`, `explanation` (no historical), 1–3 citations | Sonnet |
| `deep` | ≤10 s (D07 best-effort) | + `historical_context`, full analogies/examples, web + internal citations, verification | Opus + RAG |
| `error` | n/a | partial card + `grounding.verification_state` reason | — |

F03 renders progressively: shows the skeleton chip immediately, hydrates the
card body when `enriched` arrives, reveals a "deep dive" when `deep` arrives.

---

## 3. `KnowledgeGraphNode` (F02 owns)

```jsonc
{
  "id": "kgn_01HW...",                 // ULID, stable
  "revision": 2,
  "session_id": "uuid",
  "tenant_id": "uuid",

  "label": "Retrieval-Augmented Generation",
  "node_type": "concept",              // concept|topic|entity|speaker|insight|document|event
  "concept_card_id": "cc_...",         // null for speaker/document nodes
  "domain": "software",
  "aliases": ["RAG"],

  "salience": 0.82,
  "degree": 7,                          // cached neighbor count for layout/ranking
  "first_seen_segment_id": "seg_...",
  "first_seen_t_us": 0,
  "last_seen_t_us": 0,

  "embedding_ref": "vec_...",          // pointer into vector store (not inlined)
  "consent_class": "standard",
  "created_at_us": 0,
  "updated_at_us": 0
}
```

**`node_type` enum:** `concept | topic | entity | speaker | insight | document |
event`. Speaker nodes link the graph to F01's `speaker_id`; insight nodes link
to `InsightItem`s; document nodes link to retrieved sources.

---

## 4. `KnowledgeGraphEdge` (F02 owns)

```jsonc
{
  "id": "kge_01HW...",
  "revision": 1,
  "session_id": "uuid",
  "tenant_id": "uuid",

  "src": "kgn_...",                    // source node id
  "dst": "kgn_...",                    // target node id
  "relation": "mentions",              // see RELATION enum
  "directed": true,

  "weight": 0.74,                       // 0-1 strength/recency-decayed
  "confidence": 0.81,                   // extractor confidence in the relation
  "evidence_segment_ids": ["seg_..."], // transcript provenance for the relation
  "first_seen_t_us": 0,
  "last_seen_t_us": 0,
  "created_at_us": 0,
  "updated_at_us": 0
}
```

**`relation` enum (typed, domain-aware):** `mentions | discusses | defines |
is_a | part_of | causes | depends_on | contrasts_with | example_of |
attributed_to (speaker→concept) | decided_by | raised_by | references |
temporal_follows | same_as (entity resolution) | related_to`.

**`kg_delta` payload (incremental graph updates).** To meet D07/D02, F02 emits
small deltas, not full-graph snapshots:

```jsonc
{
  "message_type": "kg_delta",
  "payload": {
    "session_id": "uuid",
    "delta_seq": 412,                  // monotonic; F03 applies in order, requests resync on gap
    "upsert_nodes": [ /* KnowledgeGraphNode */ ],
    "upsert_edges": [ /* KnowledgeGraphEdge */ ],
    "remove_node_ids": ["kgn_..."],    // rare: merges/dedup
    "remove_edge_ids": ["kge_..."],
    "snapshot_offer": false            // true => full snapshot available on request (gap recovery)
  }
}
```

---

## 5. `InsightItem` (F02 owns)

Action items, decisions, and open questions extracted from the conversation.

```jsonc
{
  "id": "ii_01HW...",
  "revision": 2,
  "session_id": "uuid",
  "tenant_id": "uuid",

  "insight_type": "action_item",       // action_item | decision | open_question | risk | commitment
  "status": "open",                    // open|resolved|superseded|dismissed
  "text": "Send the revised pricing model to legal by Friday.",
  "normalized_text": "Send revised pricing model to legal",

  "owner_speaker_id": "sp_3",          // who is responsible (action/commitment)
  "raised_by_speaker_id": "sp_1",
  "due": { "raw": "by Friday", "resolved_iso": "2026-06-05", "confidence": 0.7 },

  "evidence_segment_ids": ["seg_..."], // transcript provenance (required, >=1)
  "first_seen_t_us": 0,
  "graph_node_id": "kgn_...",
  "related_concept_ids": ["cc_..."],

  "confidence": 0.86,
  "salience": 0.7,
  "consent_class": "standard",
  "pii_present": true,                 // owner names => PII, per D10
  "model_provenance": { "extractor_tier": "haiku", "refiner_tier": "sonnet" },
  "created_at_us": 0,
  "updated_at_us": 0
}
```

**`insight_type` enum:** `action_item | decision | open_question | risk |
commitment`. **`status` enum:** `open | resolved | superseded | dismissed`.
Status transitions are emitted as new `revision`s (e.g. a later statement
resolves an earlier open question → `status: resolved`, `revision++`).

---

## 6. Contract invariants (machine-checkable)

| # | Invariant | Enforced where |
|---|---|---|
| INV-1 | Every `ConceptCard.sources[]` with `type != model_parametric` cites ≥1 real provenance (segment/url/doc). | Extraction + grounding gate (team-03/04). |
| INV-2 | Every claim in `explanation.plain_language` maps to ≥1 citation OR is flagged parametric and visibly marked. | Grounding gate (team-04). |
| INV-3 | Every `KnowledgeGraphEdge.{src,dst}` references an existing node `id` in the same session. | Graph builder (team-03). |
| INV-4 | Every `InsightItem.evidence_segment_ids` non-empty. | Insight extractor (team-03). |
| INV-5 | `revision` strictly increases per `id`; consumers drop stale. | Envelope contract. |
| INV-6 | `consent_class=sensitive` or `pii_present=true` ⇒ no external web retrieval populated `sources`. | Retrieval gate (team-05), per D10. |
| INV-7 | All IDs are ULIDs (sortable, collision-resistant); `*_ref` pointers resolve within tenant scope. | All producers. |

---

## 7. Versioning & compatibility policy

- **Additive changes** (new optional field, new enum value behind feature flag)
  → minor bump, same `v1`, consumers ignore unknown fields.
- **Breaking changes** (rename/remove/retype, semantic change) → `v2`; F02 dual-
  emits `v1`+`v2` for one deprecation window; announce on `INTEGRATION.md`.
- F03 must tolerate unknown enum values by falling back to `general`/`related_to`
  rather than erroring (forward-compat requirement on the renderer).
