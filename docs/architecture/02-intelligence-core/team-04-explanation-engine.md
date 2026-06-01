# Team 04 — AI Explanation Engine

> Lane **F02 / Conversational Intelligence Core**. Takes skeleton `ConceptCard`s
> (from Team 3) + retrieved evidence (from Team 5) and produces grounded,
> plain-language explanations: definitions, analogies, examples, surfaced
> assumptions/hidden context, historical context, and explanations of referenced
> tech — streamed `enriched` → `deep`. Honors D04 (tiers), D07 (first-token
> ≤1000 ms, deep ≤10 s), D10 (privacy). Schemas: `data-contracts.md`.

This team owns **explanation quality and grounding**. It does NOT decide *which*
concepts to explain (Team 3 salience) nor *fetch* the evidence (Team 5 RAG); it
orchestrates prompting over that evidence and is the **anti-hallucination gate**.

---

## 1. Architecture

### 1.1 Two-pass streaming explanation

A `ConceptCard` is explained in two latency-tiered passes so the user sees value
fast and depth arrives later (matches the card lifecycle in `data-contracts.md`):

```
skeleton ConceptCard (from T3)
        │
        ▼
┌──────────────────────────── PASS A: ENRICH (hot) ─────────────────────────┐
│ 1. Assemble compact context (conversation window + glossary + card)        │
│ 2. Sonnet-tier streaming call → definition_short + plain_language +        │
│    1 analogy + 1-2 examples + surfaced assumptions/hidden context          │
│ 3. Grounding gate (cheap): every claim cites transcript or marked          │
│    parametric; stream tokens to F03 as they pass                           │
│  → first token ≤1000 ms (D07).  state=enriched                             │
└────────────────────────────────────────────────────────────────────────────┘
        │ (in parallel / on-demand)
        ▼
┌──────────────────────────── PASS B: DEEP (best-effort ≤10s) ──────────────┐
│ 1. Trigger Team 5 RAG (web + internal docs) for the concept                │
│ 2. Opus-tier call over retrieved+verified evidence → historical_context,   │
│    richer examples/analogies, referenced_tech expansion                     │
│ 3. Full grounding + NLI verification (Team 5 fact-verifier)                │
│ 4. Attach citations (Team 5 model); set verification_state                 │
│  → streams in over ≤10 s.  state=deep                                       │
└────────────────────────────────────────────────────────────────────────────┘
```

| Pass | Trigger | D04 tier | Budget | Grounding |
|---|---|---|---|---|
| **A — Enrich** | Auto for cards above salience threshold | **Sonnet** (real-time hot path) | first-token ≤1000 ms | transcript-grounded + parametric-marked; cheap entailment |
| **B — Deep** | User opens card OR high-salience auto | **Opus** (deep explanation) + RAG | ≤10 s best-effort | full RAG citations + NLI verification (Team 5) |

Routing tier (Haiku) is used only for **micro-decisions**: "is this card worth
enriching now?", reading-level/audience classification, and self-check
verification prompts — never for the explanation prose itself.

### 1.2 What the explanation covers (mapped to contract)

| Capability | Method | → `ConceptCard.explanation` field |
|---|---|---|
| Plain-language explanation | Sonnet, audience-tuned reading level | `plain_language` |
| Simplify jargon | Rewrite to target CEFR level; expand inline acronyms | `plain_language`, `reading_level` |
| Definitions | Short grounded gloss (Pass A) | `definition_short` |
| Examples | Concrete, domain-relevant; prefer in-conversation examples | `examples` |
| Analogies | Map to a familiar source domain; mark as analogy (not fact) | `analogies` |
| Surface assumptions | Prompt the model to name unstated premises the speakers rely on | `assumptions_surfaced` |
| Hidden context | What's implied but unsaid (the contrast/intent behind the term) | `hidden_context` |
| Historical context | Pass B only, RAG-grounded ("introduced 2020, by…") | `historical_context` |
| Referenced tech/products | Detect named tech, link to its own card or short gloss | `referenced_tech` |

### 1.3 Prompting strategy

- **Role decomposition, not one mega-prompt.** Separate prompts for enrich vs
  deep vs verify. Each has a fixed system contract + variable evidence block.
- **Prompt caching.** The system prompt, persona/audience instructions, domain
  style guide, and the **stable conversation summary** are placed in cacheable
  prompt prefixes (Claude prompt caching) so only the per-card delta is fresh
  tokens — major latency + cost win on the hot path (D04/D07).
  > **⚠ Refined by doc 12 (H-3, 2026-06-01).** The 1000 ms first-token budget
  > assumes a *warm* cache, but the rolling summary (refreshed by the §1.5 Haiku
  > job) sits in the cached prefix → each refresh evicts it → miss. Fix: **layered
  > cache breakpoints** — stable prefix in a long-lived block, volatile summary in
  > its **own later** block (refresh costs ~+200 ms, not ~+600 ms) — plus a
  > keep-warm ping and a cold-first-card SLO exemption. See `12-latency-budget.md`.
- **Constrained output.** Explanations emit a JSON-shaped structure (tool/JSON
  mode) matching `ConceptCard.explanation`, so fields are renderable without
  post-parsing and claims are individually attributable.
- **Evidence-first prompting.** The prompt presents retrieved evidence + the
  exact transcript spans, then instructs: *"Explain using ONLY the evidence
  below. For any sentence not supported by evidence, mark it [GENERAL KNOWLEDGE].
  Do not invent citations."* This drives INV-2.
- **Audience & reading-level conditioning.** `audience_profile`
  (general/practitioner/expert) and target CEFR level injected; controls jargon
  expansion depth and example complexity.
- **Few-shot exemplars** per domain (finance/legal/medical/tech) kept in the
  cached prefix to enforce tone and structure.

### 1.4 Retrieval strategy (what Team 4 asks Team 5 for)

Pass A is **conversation-grounded only** (no external fetch) to hit 1000 ms.
Pass B issues a structured retrieval request to Team 5:

```jsonc
{ "concept_card_id": "cc_...", "canonical_name": "...", "domain": "...",
  "need": ["definition","historical_context","authoritative_source"],
  "consent_class": "standard", "max_latency_ms": 9000, "k": 6 }
```

Team 5 returns ranked, trust-tiered, verified evidence; Team 4 conditions the
Opus call on it. If `consent_class=sensitive`/`pii_present` → external retrieval
suppressed (INV-6, D10); deep pass falls back to parametric + transcript with a
visible "no external sources used (privacy)" note.

### 1.5 Context-management strategy

The conversation can run 30+ min (D02) — far more than we want in every prompt.
Strategy:

| Context piece | What's fed | Mechanism |
|---|---|---|
| **Card span** | The concept + its mention segments (`mention_segment_ids`) | always, small |
| **Local window** | ±N segments around first/last mention | sliding window, ~1–2k tokens |
| **Rolling summary** | A continuously-maintained abstractive summary of the session so far | maintained by a background **Haiku** summarizer every K segments; cached prefix |
| **Graph neighborhood** | `related_concept_ids` canonical names + relations | compact bullet list from the KG |
| **Glossary / prior cards** | Definitions already produced this session | cache; prevents re-explaining + ensures consistency |

This keeps each explanation prompt **bounded (~3–5k tokens)** regardless of
session length. The rolling summary + glossary are the "long-term memory"; the
local window is "short-term". (Note: runtime *memory orchestration* across agents
is F03/Team 7; here we define only what context **this capability** consumes.)

### 1.6 Quality / grounding controls (anti-hallucination)

Layered defense — the core value prop is *trustworthy* explanation:

1. **Evidence-only prompting** (1.3) + explicit parametric marking.
2. **Constrained generation** → every claim attributable to a citation slot.
3. **Self-check pass (Haiku):** a cheap verifier re-reads the explanation vs
   evidence and flags unsupported sentences → `grounding.hallucination_flags`.
4. **NLI entailment verification (Team 5, Pass B):** each claim scored for
   entailment against its cited source; `support_score`; below threshold →
   claim redacted or marked `contested`. Sets `groundedness_score`.
5. **Citation requirement (INV-1/2):** non-parametric claims must carry ≥1
   citation; UI shows source inline.
6. **Confidence surfacing:** `verification_state` ∈
   {unverified, verified, contested, refuted}; F03 renders accordingly (e.g.
   contested claims visually flagged).
7. **Analogy honesty:** analogies explicitly labeled, never cited as fact.
8. **No-fabrication on empty evidence:** if evidence is insufficient, emit
   `definition_short` only + "needs more sources" rather than inventing depth.

---

## 2. Technology recommendations

| Concern | Choice | Why (D04) |
|---|---|---|
| Enrich pass | **Claude Sonnet**, streaming, prompt-cached prefix | Real-time hot-path tier; fast first token. |
| Deep pass | **Claude Opus**, streaming, over verified evidence | Deep-explanation tier; quality + reasoning. |
| Micro-decisions / self-check / summarizer | **Claude Haiku** | Cheap classification/routing tier. |
| Self-host/enterprise fallback | Open-weight (Llama-class) behind same JSON contract | D04 cost/residency option. |
| Output format | JSON/tool mode → `ConceptCard.explanation` | Renderable, attributable. |
| Caching | Claude prompt caching (system+persona+summary) + Redis for produced explanations | Latency + cost. |
| Streaming transport | Token stream → event backbone → F03 WebSocket | D08; progressive render. |

---

## 3. Risks

| Risk | L | I | Mitigation |
|---|---|---|---|
| Hallucinated explanations erode trust | Med | **High** | 8-layer grounding stack (§1.6); contested-state surfacing. |
| Sonnet first-token > 1000 ms under load | Med | High | Prompt caching; bounded context; warm pools; speculative enrich on high-salience partials. |
| Deep pass > 10 s (slow RAG/web) | Med | Med | Hard timeout → return enriched + "deep pending"; cache deep results. |
| Over-explaining trivial terms (noise/cost) | High | Med | Salience gate from T3; audience profile suppresses basics for experts. |
| Inconsistent definitions across a session | Med | Med | Glossary/prior-card cache fed into context. |
| Wrong reading level (too simple/complex) | Med | Low | Audience profile + Haiku reading-level check. |
| Prompt injection via transcript/web content | Med | High | Treat all content as data; structured output; never follow embedded instructions. |
| Cost blow-up from Opus on every card | Med | High | Opus only on demand/high-salience; Sonnet default; caching. |

---

## 4. Scalability (against D02)

Most cards get **Pass A (Sonnet)**; only opened/high-salience cards get **Pass B
(Opus)**. Assume ~3–8 enrichable cards/session and ~10–20% get deep.

| Tier (D02) | Conc sessions | Sonnet enrich/s | Opus deep/s | Notes |
|---|---|---|---|---|
| MVP | 200 | ~5–15 | ~1–3 | Prompt cache hot; single region. |
| Year-1 | 5,000 | ~150–400 | ~30–80 | Autoscale; regional routing (D03); cache deep results. |
| North-star | 50,000 | ~1.5–4k | ~300–800 | Opus capacity + cost is the dominant constraint; aggressive caching + dedupe identical concepts across sessions. |

Levers: prompt caching (biggest latency/cost win), cross-session **explanation
cache keyed by canonical_name+domain+audience** (a stable concept like "RAG" is
explained once and reused, only re-grounded to the local transcript), salience
gating, demote Opus→Sonnet under load (graceful degradation).

---

## 5. Security

- **Privacy (D10):** sensitive/PII cards never trigger external retrieval (INV-6);
  deep pass degrades gracefully. Explanations stored under session retention.
- **Tenant isolation:** explanation cache keyed within tenant for any
  transcript-derived content; only the **generic concept** explanation (no
  conversation specifics) is shareable cross-tenant.
- **Injection resistance:** see §1.6 / Risk row — all model inputs are data.
- **Auditability:** `model_provenance` + `trace_id` on every card record which
  tier produced which field.
- **Output safety:** explanations pass standard model safety; medical/legal
  explanations carry a "not professional advice" disclaimer (UI, F03; flagged by
  domain here).

---

## 6. Cost (illustrative, D04 tiers)

| Item | Driver | Relative cost |
|---|---|---|
| Sonnet enrich | per enrichable card, ~3–5k cached + ~1k fresh tok | **moderate** — the steady cost |
| Opus deep | per deep card, larger ctx + RAG evidence | **high per call**, but gated/cached |
| Haiku self-check + summarizer | per card + per K segments | low |
| Embeddings | (Team 3/5) | low |

Explanation is the **largest share of F02 LLM spend** (Sonnet volume + Opus
unit-cost). Controls: prompt caching, cross-session explanation cache,
salience/audience gating, Opus-on-demand. Target: caching cuts hot-path tokens
≥50%; cross-session cache cuts repeat-concept cost ≥40% at scale.

---

## 7. MVP scope

**In:** Pass A enrich (Sonnet) with definition, plain-language, analogy,
examples, surfaced assumptions/hidden context; Pass B deep (Opus) with historical
context + referenced-tech + RAG citations for opened cards; full grounding stack;
prompt caching; rolling-summary context management; audience profile (general
default).

**Out (defer):** per-user personalized explanation style learning; multi-turn
"ask a follow-up about this card" (that's F03 interaction surface); non-English;
fine-tuned explainer.

---

## 8. Future enhancements

- **Interactive deepening**: follow-up Q&A on a card (capability hook; F03 drives).
- Personalized reading level / interest profile per user.
- Distilled explainer model for common concepts (cut Sonnet cost).
- Visual explanation generation (diagrams) as structured spec for F03 to render.
- Cross-session "you already know X" — skip basics the user has seen.
- Multilingual explanation.

---

## 9. Assumptions

- A01: Team 3 supplies skeleton cards with salience + mention spans.
- A02: Team 5 supplies ranked, trust-tiered, NLI-verifiable evidence on request.
- A03: Claude prompt caching + streaming are available (D04).
- A04: F03 renders progressive states (skeleton/enriched/deep) and contested
  flags (contract §2 lifecycle).
- A05: 30-min sessions (D02) ⇒ summarization is required, not optional.

## 10. Decisions

- DE-1: Two-pass (Sonnet enrich → Opus deep) streaming, not single Opus call —
  to hit first-token ≤1000 ms (D07) while still offering depth.
- DE-2: Pass A is conversation-grounded only; external RAG is Pass-B-only.
- DE-3: Evidence-only prompting + parametric marking + NLI verification is
  mandatory (anti-hallucination is a product requirement, not a nice-to-have).
- DE-4: Prompt caching of system+persona+rolling-summary prefix is standard.
- DE-5: Cross-session explanation cache keyed by canonical_name+domain+audience.

## 11. Tradeoffs

| Choice | Gain | Cost |
|---|---|---|
| Sonnet enrich vs Opus everywhere | Latency + cost | Slightly shallower default explanation. |
| Conversation-only Pass A | Hits 1000 ms | No external facts until deep pass. |
| Strict grounding | Trust | Some explanations shorter / "needs sources". |
| Cross-session cache | Big cost cut | Cache must re-ground to local transcript; staleness risk. |
| Rolling summary memory | Bounded prompts | Summary lossiness; mitigated by local window. |

## 12. Open questions

- OQ-1: Salience threshold for auto-enrich vs on-open-only (tune with usage).
- OQ-2: Default audience profile per vertical?
- OQ-3: How aggressively to cache cross-session explanations vs privacy concerns
  about leaking that a concept was discussed (coordinate F09).
- OQ-4: Deep-pass timeout value (10 s ceiling vs perceived responsiveness).
- OQ-5: Disclaimer policy for regulated-domain explanations (coordinate F09/F05).

## 13. Estimated complexity

**High.** Prompt engineering for grounded, multi-domain explanation + the
verification stack + latency-bounded streaming + caching strategy. ~3 engineers
+ prompt/eval specialist, ~2 quarters to MVP. The grounding/verification loop is
the riskiest sub-component and needs a dedicated eval harness.
