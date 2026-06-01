# Team 05 — Research & Context Retrieval

> Lane **F02 / Conversational Intelligence Core**. The evidence layer: RAG over
> session memory + internal docs + the web, with citation generation, fact
> verification, source ranking, and context enrichment. Serves Team 4 (deep
> explanation) and grounds every `ConceptCard`. Honors D04 (tiers), D07 (deep
> ≤10 s), D09 (vector store), D10 (privacy). Schemas: `data-contracts.md`.

This team owns **truth and provenance**. It does NOT write explanation prose
(Team 4) or extract concepts (Team 3); it finds, ranks, verifies, and cites the
evidence those teams stand on. It is the source of the **Citation model**.

---

## 1. Architecture

### 1.1 Retrieval pipeline (hybrid RAG)

```
Retrieval request (from Team 4, §1.4 of team-04)
        │  {canonical_name, domain, need[], consent_class, k, max_latency_ms}
        ▼
┌──── 1. Query planning (Haiku) ────────────────────────────────────────────┐
│  • expand query, pick sub-queries, choose sources by `need` + domain        │
│  • privacy gate: consent_class=sensitive|pii ⇒ disable web/internal external │
└─────────────────────────────────────────────────────────────────────────────┘
        ▼  (fan-out, parallel, each time-boxed)
┌─────────────┬──────────────────┬───────────────────┬───────────────────────┐
│ A. Session  │ B. Internal KB   │ C. Curated         │ D. Live web search     │
│ memory      │ (tenant docs,    │ reference corpus   │ (cache-first, then     │
│ (this conv) │  glossary)       │ (encyclopedic,     │  provider API)         │
│ pgvector    │ pgvector+BM25    │  pre-indexed)      │                        │
└─────────────┴──────────────────┴───────────────────┴───────────────────────┘
        ▼
┌──── 2. Hybrid merge: dense (embeddings) + sparse (BM25) → RRF fusion ──────┐
└─────────────────────────────────────────────────────────────────────────────┘
        ▼
┌──── 3. Rerank (cross-encoder) → top-k ─────────────────────────────────────┐
        ▼
┌──── 4. Source ranking / trust-tier scoring (T1..T4) ───────────────────────┐
        ▼
┌──── 5. Fact verification (NLI entailment per claim) ───────────────────────┐
        ▼
┌──── 6. Citation assembly → return ranked, verified Citation[] to Team 4 ───┘
```

Each source channel is **time-boxed** so the union respects `max_latency_ms`
(≤9 s of the 10 s deep budget, leaving headroom for Team 4's Opus call). Session
memory + internal KB are fast (<150 ms); web is the long pole (cache-first).

### 1.2 The four retrieval channels

| # | Channel | Index | Latency | Trust default | Use |
|---|---|---|---|---|---|
| A | **Session memory** | pgvector, `(tenant,session)` namespace | <50 ms | T1 (it's what was said) | Ground claims in the actual conversation. |
| B | **Internal/tenant docs** | pgvector + BM25 hybrid | <150 ms | T2 | Org glossary, uploaded docs, prior sessions. |
| C | **Curated reference corpus** | pre-indexed encyclopedic/domain corpus | <200 ms | T2–T3 | Stable definitions/history without a live web hit. |
| D | **Live web search** | provider API + result cache | 0.3–3 s | T3–T4 (domain-scored) | Fresh/uncovered facts, current events. |

Channel D is **cache-first**: a Redis/S3-backed result cache keyed by
normalized query + freshness window; identical concept lookups across sessions
reuse fetched+verified results (huge at scale).

### 1.3 Web search integration

- **Provider-abstracted**: a `WebSearchProvider` interface so the vendor
  (Brave / Bing / Google PSE / Tavily / Perplexity-API-class) is swappable; the
  choice is a manual procurement task (MAN-F02-001).
- Flow: query plan → search API → fetch top results → **extract main content**
  (readability/boilerplate strip) → chunk → embed → into the rerank pool.
- **Content is untrusted data** (prompt-injection safe; never executed as
  instructions).
- **Robots/ToS + rate limits** respected; results cached; per-tenant quota.
- **Freshness**: query plan tags whether the concept needs fresh data (current
  events, prices) vs stable (definitions) — stable hits curated corpus first.

### 1.4 Internal document search

- Tenant-uploaded docs / wikis / prior session transcripts, ingested via an
  embedding + BM25 hybrid index, namespaced by `tenant_id`.
- Strict tenant isolation (INV-7); never cross-tenant.
- Powers enterprise value: "explain this using our docs."
- Ingestion pipeline (chunk → embed → index) is a capability here; provisioning
  the store is F04 (D09).

### 1.5 Source ranking (trust tiers + relevance)

Final ordering = **relevance × trust × freshness-fit × diversity**:

| Tier | Meaning | Examples | Weight |
|---|---|---|---|
| **T1** | Conversation itself / authoritative primary | transcript spans, the spoken source | highest |
| **T2** | Tenant-trusted / curated reference | internal docs, curated corpus, standards bodies, official docs | high |
| **T3** | Reputable secondary | established media, well-known technical sites, encyclopedias | medium |
| **T4** | Open web / unranked | blogs, forums, low-authority pages | low (used only to corroborate, never sole source) |

Trust score from a domain-authority table + signals (domain age, citations,
HTTPS, recency). A claim grounded **only** on T4 is marked `unverified`/low
`support_score`; Team 4 must caveat it.

### 1.6 Fact verification

Per-claim **NLI entailment** between each explanation claim and its candidate
source snippet:

```
claim  +  source snippet  ──▶ NLI model ──▶ {entails | neutral | contradicts}
                                              + support_score (0-1)
  entails (score ≥ τ)      → citation accepted, verification_state contributes "verified"
  neutral                  → weak; needs another source or marked unverified
  contradicts              → conflict! escalate ↓
```

- **Conflict handling**: if high-trust sources disagree → `verification_state =
  contested`, surface both (Team 4 presents the disagreement rather than picking).
  A refuting high-trust source → `refuted`, claim dropped.
- **Verifier tiers (D04)**: cheap NLI (Haiku-tier or a small NLI model) for the
  bulk pass; escalate ambiguous/contested cases to Sonnet for adjudication.
- Produces `grounding.groundedness_score` and per-claim `support_score` on the
  `ConceptCard`.

### 1.7 Citation model (authoritative)

Citations are the `ConceptCard.sources[]` entries (see `data-contracts.md` §2).
Canonical shape:

| Field | Meaning |
|---|---|
| `citation_id` | ULID. |
| `type` | `transcript` \| `web` \| `internal_doc` \| `model_parametric`. |
| `transcript_segment_ids` / `url` / `doc_id` | provenance pointer by type. |
| `title`, `snippet` | the **exact** supporting quote (no paraphrase in the snippet). |
| `retrieved_at` | freshness. |
| `trust_tier` | T1–T4 (§1.5). |
| `support_score` | NLI entailment of the cited claim (§1.6). |

Rules: every non-parametric claim carries ≥1 citation (INV-1/2); `snippet` must
be a verbatim span from the source (enables UI "show source"); `model_parametric`
citations are visibly marked as model knowledge, not a source.

### 1.8 Context enrichment

Beyond per-claim citations, Team 5 enriches a concept with:
- **Related-entity expansion** from the KG neighborhood (Team 3) to fetch context
  for adjacent concepts.
- **Background pack** for the deep pass: definition + history + canonical
  reference, pre-assembled so Team 4's Opus call is grounded in one bundle.
- **Cross-session recall** (future): "you discussed this before" pulled from the
  user's prior-session index (privacy-gated, F09).

---

## 2. Technology recommendations

| Concern | MVP | Scale | Why |
|---|---|---|---|
| Vector store | **pgvector** (D09) | dedicated vector DB (Qdrant/Pinecone/Milvus-class) | D09 trajectory. |
| Sparse search | Postgres FTS / BM25 | OpenSearch/Elastic | Hybrid recall. |
| Fusion | Reciprocal Rank Fusion | same | Robust dense+sparse merge. |
| Reranker | hosted/open cross-encoder (BGE-reranker-class) | same, GPU-served | Precision@k. |
| Embeddings | hosted embedding model + open fallback (D04) | same | Consistent with Team 3 index. |
| Query planning / verify | **Haiku** bulk, **Sonnet** escalation (D04) | same | Cheap routing + adjudication. |
| Web search | provider-abstracted (Brave/Bing/Tavily-class) | + multi-provider + cache | Swappable; procurement = manual task. |
| Content extraction | readability/trafilatura-class | same | Strip boilerplate before embedding. |
| Cache | Redis (queries) + S3 (fetched docs) | + CDN | Cache-first web; cross-session reuse. |
| NLI verifier | small NLI model or Haiku | + Sonnet adjudication | Per-claim grounding. |

---

## 3. Risks

| Risk | L | I | Mitigation |
|---|---|---|---|
| Web latency blows the 10 s deep budget | High | Med | Time-box channels; cache-first; return enriched + "deep pending" on timeout. |
| Low-quality/biased web sources | Med | High | Trust tiers; T4 never sole source; NLI verification; diversity. |
| Verifier false-accepts a hallucination | Med | High | Threshold tuning; require ≥1 T1–T3 source for asserted facts; eval harness. |
| Web/internal content prompt injection | Med | High | Content treated as data; sanitized; never instructions. |
| PII/consent leak via external search (D10) | Med | **High** | Privacy gate disables external channels for sensitive/PII (INV-6). |
| Web API cost/quota blow-up | Med | Med | Cache-first, per-tenant quota, dedupe cross-session. |
| Stale cached results | Med | Low | Freshness window per concept type; bypass cache for "fresh-needed" queries. |
| Vendor lock-in (search/vector) | Med | Med | Provider abstraction interfaces. |

---

## 4. Scalability (against D02)

Retrieval fires mainly on the **deep pass** (a subset of cards). Cache-first +
cross-session dedupe is the key scaler.

| Tier (D02) | Conc sessions | Retrieval reqs/s | Web fetches/s (post-cache) | Notes |
|---|---|---|---|---|
| MVP | 200 | ~1–3 | <1 (cache cold→warm) | pgvector; single search provider. |
| Year-1 | 5,000 | ~30–80 | ~5–15 | Dedicated vector DB; cache hit-rate >70%; reranker GPU pool. |
| North-star | 50,000 | ~300–800 | ~30–80 | Multi-provider web; regional indices (D03); cache hit-rate >85% for common concepts; verify pass batched. |

Levers: cache-first web + **cross-session evidence cache** keyed by
canonical_name+domain (a concept's background is fetched/verified once), channel
time-boxing, reranker batching, regional vector indices.

---

## 5. Security

- **Privacy (D10):** the **privacy gate** in query planning is the hard line —
  sensitive/PII concepts never leave the tenant boundary to the web (INV-6).
  No-audio-retention mode unaffected (we index text/derived only).
  > **⚠ Hardened by D20 / doc 13 (2026-06-01).** The gate keys on `consent_class`
  > and `pii_present`, which this lane **assumed already set** (A01) — but nothing
  > computed `pii_present` and the natural default was **fail-open**. D20 adds a
  > named layered PII/PHI classifier (deterministic + NER + Comprehend-Medical/
  > in-VPC), **recall ≥0.95 PII / ≥0.98 PHI**, and a **fail-closed** default
  > (missing/uncertain ⇒ treat as sensitive). Also **INV-9**: the cross-session
  > evidence cache must hold **no personal data** (else it escapes the DSAR
  > cascade — M-9). See `00-integration/13-consent-and-privacy-redesign.md`.
- **Tenant isolation (INV-7):** internal-doc and session indices namespaced by
  `tenant_id`; ANN + BM25 queries scoped; verified no cross-tenant retrieval.
- **Injection safety:** all retrieved content is data; sanitized; the verifier
  and explainer never follow embedded instructions.
- **Egress controls:** web fetch via an allowlistable egress proxy; respects
  robots/ToS; logs for audit (F09).
- **Citation integrity:** snippets verbatim + `support_score` so the UI can prove
  provenance; reduces misinformation liability.
- Encryption/at-rest owned by F04; F02 stores derived evidence under retention
  policy (D10).

---

## 6. Cost (illustrative, D03/D04)

| Item | Driver | Relative |
|---|---|---|
| Web search API | per uncached deep query | **moderate**, controlled by cache + quota |
| Embeddings | ingest + query | low–moderate |
| Reranker | per deep query (GPU) | moderate at scale |
| NLI verification | per claim (Haiku/small model) | low |
| Vector/sparse store | infra (F04) | moderate at scale |

Cost levers: cache-first web (target >80% hit at scale), cross-session evidence
cache, curated corpus to avoid web hits for stable facts, per-tenant quotas.
Retrieval should be **a minority of F02 LLM spend** (verification is cheap;
search API + reranker infra are the real costs).

---

## 7. MVP scope

**In:** hybrid RAG (session memory + internal docs + curated corpus + web) with
RRF + cross-encoder rerank; trust-tiered source ranking (T1–T4); per-claim NLI
fact verification with contested/refuted handling; citation model with verbatim
snippets; cache-first web (single provider); privacy gate (INV-6); context
enrichment background pack for the deep pass.

**Out (defer):** multi-provider web federation; cross-session user recall; image/
table source extraction; specialized domain corpora (clinical, legal databases —
licensing required, MAN-F02-004); multilingual retrieval.

---

## 8. Future enhancements

- Multi-provider web federation + answer-quality routing.
- Licensed authoritative corpora per vertical (UpToDate-class medical,
  Westlaw-class legal) behind the trust-tier model.
- Cross-session / personal knowledge recall (privacy-gated).
- Self-hosted web index for enterprise/air-gapped deployments.
- Learned source-trust model from user feedback.
- Multimodal sources (PDFs with tables, charts).

---

## 9. Assumptions

- A01: Team 4 issues structured retrieval requests with `consent_class` set.
  *(⚠ This assumption was the H-13 fail-open root cause — `consent_class`/`pii_present`
  must be computed and fail-closed, not assumed-set. See D20 / doc 13.)*
- A02: Team 3's embeddings/index are reusable for session-memory retrieval
  (shared embedding model).
- A03: A web-search vendor account/keys will be provisioned (MAN-F02-001).
- A04: F04 provisions the vector + sparse stores (D09); F02 owns access patterns.
- A05: English-first corpora (IDEA non-goal).

## 10. Decisions

- DE-1: Hybrid (dense+sparse) retrieval with RRF + cross-encoder rerank — best
  recall/precision tradeoff for mixed query types.
- DE-2: Four channels with **time-boxing**; web is cache-first and the long pole.
- DE-3: Trust-tier model (T1–T4); T4 never a sole source for asserted facts.
- DE-4: Per-claim NLI verification is mandatory; contested sources are surfaced,
  not silently resolved.
- DE-5: Provider-abstracted web search to avoid lock-in.
- DE-6: Privacy gate disables external channels for sensitive/PII (INV-6, D10).

## 11. Tradeoffs

| Choice | Gain | Cost |
|---|---|---|
| Cache-first web | Latency + cost | Possible staleness; mitigated by freshness windows. |
| Time-boxing channels | Hits 10 s budget | May miss a slow but good source. |
| Cross-encoder rerank | Precision | GPU cost/latency; batched at scale. |
| Strict verification | Trust | Some claims dropped/marked unverified. |
| Curated corpus | Avoids web hits | Build/maintain + licensing cost. |

## 12. Open questions

- OQ-1: Which web-search vendor (cost/quality/ToS) — procurement (MAN-F02-001).
- OQ-2: Build vs license curated reference corpus, and which verticals first
  (MAN-F02-004).
- OQ-3: NLI entailment threshold τ per trust tier — tune with eval set.
- OQ-4: Cache TTL / freshness windows per concept category.
- OQ-5: How to present `contested` to users without overwhelming them (F03 UX).

## 13. Estimated complexity

**High.** Hybrid RAG + reranking + verification + multi-source ranking + a robust
cache and privacy gate is a substantial system. ~3 engineers + a search/IR
specialist, ~2 quarters to MVP. Fact verification quality is the make-or-break
and needs a labeled eval set and continuous tuning.
