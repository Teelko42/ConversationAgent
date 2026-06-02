# Team 07 — AI Agent Orchestration

> Lane **F03 — Experience & Agent Orchestration**. This is the **runtime brain**
> that turns a stream of `TranscriptSegment`s into `ConceptCard`s,
> `KnowledgeGraphNode/Edge`s, and `InsightItem`s — fast enough for the **D07**
> latency budget and cheap enough via the **D04** model tiers. It **orchestrates
> the F02 AI capabilities by name only** (extraction, explanation, research/RAG,
> verification); it does **not** redesign those internals. It expects a platform
> (event backbone, datastores, autoscaling) from **F04** by name.

---

## 1. Architecture

### 1.1 What orchestration owns vs. what it calls

| Owns (Team 7) | Calls by name (F02) | Depends on (F04) |
|---|---|---|
| Agent hierarchy, lifecycle, supervision | `ExtractionCapability` | Event backbone (D08) |
| Task routing & model-tier selection (D04) | `ExplanationCapability` | Datastores (D09): Postgres, vector, graph, Redis |
| Memory tiers (short/session/long) | `ResearchRetrievalCapability` (RAG + web) | Object storage (Blob) |
| Context assembly/budgeting | `GraphBuildCapability` | Autoscaling, queues, observability |
| Summarization pipelines | `InsightExtractionCapability` | Secrets/keys mgmt |
| Verification & evaluation agents | `EmbeddingCapability` | LLM gateway / rate limits |
| Failure recovery & degraded modes | (these are F02-owned skills) | |
| Latency-budget enforcement | | |

> **Capabilities** are stable, named server-side skills F02 exposes. Orchestration
> treats each as a typed RPC/stream: `in → out` contract objects (D06). Team 7
> decides *when, with what context, on which model tier, with what fallback* —
> never *how the skill reasons internally*.

### 1.2 Orchestration topology

A **hierarchical supervisor + specialized workers** model, event-driven, with two
clocks: the **hot path** (real-time, must fit D07) and the **deep path**
(best-effort, ≤10 s, research-grade).

```
                              ┌──────────────────────────────────────────────┐
   TranscriptSegment stream   │           SESSION CONDUCTOR (1 / session)      │
   (D08, ordered by seq) ────▶│  - owns session state + memory tiers           │
                              │  - segments → tasks, dedupe, salience gate     │
                              │  - routes tasks, enforces latency budget       │
                              │  - supervises workers, handles failure         │
                              └───────────────┬───────────────┬────────────────┘
                                              │ dispatch       │ dispatch
            ┌─────────────────────────────────┼───────────────┼─────────────────────────┐
            │                                  │               │                         │
   HOT PATH ▼ (≤ D07 budget)        ┌──────────▼─────┐  ┌──────▼──────┐         DEEP PATH ▼ (≤10s)
 ┌──────────────────────┐          ┌────────────────┐  ┌────────────┐    ┌──────────────────────┐
 │ Triage / Router Agent│          │ Extraction     │  │ Insight    │    │ Research Agent       │
 │ (Haiku) classify,    │─salient─▶│ Agent          │  │ Agent      │    │ (RAG + web, Sonnet/  │
 │ salience, route      │          │ →ExtractionCap │  │ →InsightCap│    │  Opus) →ResearchCap  │
 └──────────────────────┘          └───────┬────────┘  └─────┬──────┘    └──────────┬───────────┘
                                           │ ConceptCard      │ InsightItem          │ deep explanation
                              ┌────────────▼─────────┐        │            ┌─────────▼──────────┐
                              │ Explanation Agent    │        │            │ Graph Agent         │
                              │ (Sonnet hot / Opus   │        │            │ →GraphBuildCap      │
                              │  deep) →ExplanationCap│       │            │ KnowledgeGraphNode/ │
                              └───────────┬───────────┘        │           │ Edge                │
                                          │                    │           └─────────┬───────────┘
                       ┌──────────────────┼────────────────────┼─────────────────────┘
                       ▼                  ▼                     ▼
              ┌───────────────┐   ┌────────────────┐   emit contract objects →
              │ Verification  │   │ Evaluation     │   D08 stream → F03 UI (Team 6)
              │ Agent (Haiku/ │   │ Agent (offline/│
              │ Sonnet)       │   │  sampled)      │
              └───────────────┘   └────────────────┘
                       ▲ guards every user-facing claim
            ┌──────────┴───────────────────────────────────────────────────────┐
            │ MEMORY: short-term (ring buffer) · session (Redis+vector) · long  │
            │ (Postgres+vector+graph)   |   CONTEXT ASSEMBLER (budgeted)          │
            └───────────────────────────────────────────────────────────────────┘
```

### 1.3 Two-clock execution model

| Clock | Trigger | Agents | Budget | Output |
|---|---|---|---|---|
| **Hot path** | Every finalized (or stable-partial) `TranscriptSegment` | Triage → Extraction → (Explanation std) → Insight → Graph(incremental) → Verification(light) | Must fit D07: extraction ≤700 ms, explanation first-token ≤1 s | First useful `ConceptCard` p50 ≤3 s |
| **Deep path** | Salient concept, user "Explain deeper", topic boundary | Research → Explanation(Opus) → Verification(full) → Graph(reconcile) | Best-effort ≤10 s, streamed | Research-grade explanation deltas, citations |

---

## 2. Agent hierarchy & responsibilities

| Agent | Tier (D04) | Trigger | Responsibility | In → Out | Latency target |
|---|---|---|---|---|---|
| **Session Conductor** | n/a (logic) | session start | Orchestrate everything: state, routing, budget, supervision, memory | session events → dispatches | overhead < 30 ms/segment |
| **Triage / Router Agent** | Haiku | each segment | Classify domain, detect novel concepts/jargon, score salience, decide route (skip / hot / deep), dedupe vs session memory | `TranscriptSegment`(+ctx) → routing decision | ≤150 ms |
| **Extraction Agent** | Haiku→Sonnet | salient segment | Call `ExtractionCapability`; produce concept/entity/acronym candidates → draft `ConceptCard` | segment(+window) → `ConceptCard` draft | ≤700 ms (D07) |
| **Explanation Agent** | Sonnet (hot) / Opus (deep) | new salient concept / user request | Call `ExplanationCapability`; plain-language explanation, examples, analogy, diagram spec; stream first token | concept(+ctx) → explanation stream | first-token ≤1 s (D07) |
| **Research Agent** | Sonnet orchestrate, Opus synth | deep path | Call `ResearchRetrievalCapability` (RAG + web search), gather citations, enrich card | concept(+graph) → sources + enriched explanation | ≤10 s best-effort |
| **Insight Agent** | Haiku→Sonnet | windowed segments | Call `InsightExtractionCapability`; detect actions/decisions/open-questions | segment window → `InsightItem`[] | ≤700 ms |
| **Graph Agent** | Haiku (incr) / Sonnet (reconcile) | new concept/insight | Call `GraphBuildCapability`; add/merge nodes+edges, resolve coreference, dedupe | concept/insight → `KnowledgeGraphNode/Edge` deltas | incr ≤300 ms |
| **Summarizer Agent** | Sonnet | window full / topic boundary / session end | Rolling + topical + final summaries (feeds memory + recap UI) | segment buffer → summary | rolling ≤2 s (off hot path) |
| **Verification Agent** | Haiku (light) / Sonnet (full) | before any user-facing claim | Check explanation against sources, flag low-confidence/unsupported, attach confidence + "unverified" badge | explanation+sources → verdict + confidence | light ≤300 ms |
| **Evaluation Agent** | Sonnet (sampled) | sampled / offline | Score outputs (faithfulness, relevance, latency) for quality dashboards + regression | sampled outputs → eval scores | offline |

**Supervision:** the Conductor is the only stateful per-session actor; all workers
are **stateless and idempotent** (keyed by `(session_id, seq, capability)`), so any
worker can be retried or rescheduled on another node (F04 autoscaling).

---

## 3. Agent-to-agent communication

| Mechanism | Use | Why |
|---|---|---|
| **Event bus (D08, per-session ordered)** | Conductor ↔ workers, worker outputs → UI | Durable, ordered by `seq`, replayable; decouples producers/consumers |
| **Blackboard (session memory in Redis)** | Shared session state: concepts seen, graph snapshot, rolling summary, salience index | Workers read shared context without chatty RPC |
| **Direct capability RPC/stream** | Agent → F02 capability | Typed `in→out`; streaming for explanation first-token |
| **Correlation envelope** | Every message | Carries `session_id, tenant_id, seq, task_id, parent_task_id, tier, deadline, attempt` for tracing + budget enforcement |

**Communication patterns**

```
 Conductor ──dispatch(task_id, deadline)──▶ Worker ──capability stream──▶ F02
     ▲                                         │
     │◀──── result / partial / error ──────────┘
     │   (results also published to D08 bus → UI + blackboard)
     └── Verification gate intercepts user-facing claims before publish
```

- **No agent talks to F02 except through its named capability.** No agent mutates
  another agent's state — only the Conductor + blackboard mediate.
- **Backpressure:** Conductor watches per-session queue depth; if the hot path
  saturates, it sheds via the salience gate (drop low-salience extraction) before
  it ever drops transcript rendering.

---

## 4. Memory strategy

| Tier | Scope | Store (D09) | Contents | TTL / lifecycle | Used by |
|---|---|---|---|---|---|
| **Short-term** | last N segments (sliding window, ~60–120 s) | Redis ring buffer / in-proc | Recent raw segments, partials, immediate coref context | Window-bounded | Triage, Extraction, Insight |
| **Session** | one session | Redis (hot) + pgvector (recall) | Concepts seen (dedupe index), rolling summary, topic stack, session graph snapshot, salience index, embeddings of discussed concepts | Session TTL; honors D10 retention | All hot-path agents, Summarizer, Graph |
| **Long-term** | per user / per tenant | Postgres + vector DB + graph store | "My Glossary", cross-session concept embeddings, prior explanations (cache), user domain profile, persistent knowledge graph | Per retention policy (D10); user-deletable | Personalization, dedupe across sessions, explanation cache |

**Memory policies**

- **Write path:** Summarizer compacts the short-term window into session memory at
  window/topic boundaries → bounded growth (never feed the whole transcript to a
  model).
- **Recall path:** Context Assembler does semantic recall from session+long-term
  vectors to ground explanations (RAG over the conversation itself).
- **Privacy (D10):** in no-audio-retention / no-retention mode, long-term writes
  are suppressed; session memory is ephemeral and purged at session end. PII/
  consent boundaries are flagged to **F09** (this lane creates a memory touchpoint
  → see Integration notes).
- **Coreference:** session memory holds an entity registry so "it/that metric"
  resolves to a stable `KnowledgeGraphNode`.

---

## 5. Context management (token budgeting)

Each LLM call gets a **context budget** assembled deterministically so latency and
cost stay bounded (D07/D04). Heavy use of **prompt caching** on the stable prefix.

```
┌──────────────── Context Assembler (per task) ───────────────────────────┐
│  [cached prefix]  system + capability instructions + domain glossary     │  ◀ prompt-cache hit
│  [session frame]  rolling summary (compact) + topic stack                │  ◀ from session memory
│  [recall]         top-k relevant prior concepts (vector recall)          │  ◀ budgeted k
│  [window]         last N raw segments (the live context)                 │  ◀ short-term
│  [focus]          the segment/concept this task is about                 │
│  [task]           the specific instruction + output schema (D06)         │
└──────────────────────────────────────────────────────────────────────────┘
   Budget caps: prefix cached (≈free after first hit) · session ≤ ~800 tok ·
   recall ≤ ~600 tok · window ≤ ~1k tok · keeps hot-path prompts small & fast.
```

| Technique | Effect |
|---|---|
| **Prompt caching** of system + glossary prefix | Cuts repeated input cost/latency dramatically on the hot path |
| **Rolling summary** instead of full transcript | Bounded context regardless of session length |
| **Budgeted vector recall (top-k)** | Relevant grounding without context bloat |
| **Schema-constrained outputs** (tool/JSON, D06) | Deterministic, parseable; fewer retries |
| **Per-tier budgets** | Haiku tasks get tiny contexts; Opus deep gets richer |

---

## 6. Task routing — model tier per task (per D04)

> Default tiers; the Router may upgrade/downgrade based on salience, confidence,
> domain risk (e.g., healthcare/legal → upgrade + force verification), and load.

| Task | Default tier | Upgrade trigger | Downgrade / skip trigger | Rationale |
|---|---|---|---|---|
| Triage/route/classify | **Haiku** | regulated domain | — | Cheap, ≤150 ms, runs on every segment |
| Salience scoring | **Haiku** | — | — | High volume |
| Extraction (hot) | **Haiku → Sonnet** | dense/novel jargon, low confidence | low salience → skip | Fit ≤700 ms; escalate only when needed |
| Explanation (live, standard) | **Sonnet** | user "Explain deeper", expert depth | known concept w/ cached explanation → serve cache | Hot-path quality/latency balance |
| Explanation (deep/research) | **Opus** | always for deep path | — | Best reasoning; off hot path |
| Research/RAG orchestration | **Sonnet** (Opus synth) | conflicting sources | cache hit on concept | Tool-use heavy |
| Insight detection | **Haiku → Sonnet** | ambiguous decision/action | — | Windowed, frequent |
| Graph incremental | **Haiku** | coref/merge conflict → Sonnet | — | High frequency, simple ops |
| Summarization (rolling) | **Sonnet** | — | — | Quality matters; off hot path |
| Verification (light) | **Haiku** | low confidence / regulated → Sonnet | — | Guards every claim cheaply |
| Verification (full) | **Sonnet** | deep path always | — | Source-grounded check |
| Evaluation | **Sonnet** | — | sampled only | Quality dashboards |

**Routing inputs:** salience, novelty (vs memory), domain, confidence, current
queue depth/latency headroom, and per-tenant cost ceiling. **Open-weight (Llama-
class) fallback** is available for self-host/enterprise and as a cost/availability
fallback (D04) — same capability interface.

---

## 7. Summarization pipelines

```
 segments ──▶ [rolling summarizer]──every window──▶ session "running summary"
                     │                                   │
 topic boundary ─────┴──▶ [topical summarizer] ──▶ per-topic recap (feeds Topic Explorer)
                                                         │
 session end ─────────────▶ [final summarizer] ──▶ session recap + action-item digest (Review UI)
                                                         │
 cross-session (long-term) ─▶ [profile summarizer] ─▶ user domain profile / glossary rollup
```

| Pipeline | Tier | Cadence | Consumes | Produces | Consumer |
|---|---|---|---|---|---|
| Rolling | Sonnet | every ~60–120 s window | short-term window | running summary | Context Assembler, recap |
| Topical | Sonnet | topic-boundary (from Triage) | window + topic concepts | topic recap | Topic Explorer (Team 6) |
| Final | Sonnet/Opus | session end | session memory | recap + `InsightItem` digest | Review mode |
| Profile | Sonnet | async/batch | long-term memory | domain profile, glossary | Personalization |

Summaries are **hierarchical and compounding** (map-reduce over windows) so cost
and context stay bounded for arbitrarily long sessions.

---

## 8. Verification & evaluation agents

### 8.1 Verification (inline guard)

| Step | Tier | Check | On fail |
|---|---|---|---|
| Source grounding | Haiku/Sonnet | Does the explanation's claims trace to retrieved sources / the transcript? | Strip/soften unsupported claims; lower confidence |
| Self-consistency | Haiku | Internal contradiction? | Flag for regen or mark uncertain |
| Confidence scoring | — | Aggregate to high/med/low | Attach to `ConceptCard.confidence` (rendered as a chip by Team 6) |
| Hallucination gate | Sonnet (regulated) | Risky claim w/o citation | Block publish or add "unverified" badge |

Verification sits **between worker output and publish** — nothing reaches the UI as
"verified" without passing. Latency-bounded: light verification fits inside the hot
path; full verification runs on the deep path only.

### 8.2 Evaluation (continuous quality)

| Metric | Method | Use |
|---|---|---|
| Faithfulness / groundedness | LLM-as-judge (Sonnet) on samples + curated gold set | Quality dashboard, regression gate |
| Explanation helpfulness | User 👍/👎/Report (Team 6) + judge | Tune prompts/tiers; reward signal |
| Extraction precision/recall | Gold-labeled sessions | Tune salience + extraction |
| Latency SLO adherence | Trace metrics vs D07 budget | Alerting, capacity planning |
| Cost per session | Token accounting per tier | Cost guardrails (D04) |

Evaluation is **offline/sampled** (never on the hot path) and feeds CI regression
gates plus a quality dashboard. Human feedback from the UI closes the loop.

---

## 9. Failure recovery & degraded modes

> **Principle:** the live transcript (F01) must never be blocked by AI failure.
> Intelligence degrades gracefully; capture/transcription always survives.

### 9.1 Timeouts, retries, fallbacks

| Failure | Detection | Recovery | Degraded mode |
|---|---|---|---|
| Capability slow (> deadline) | Per-task deadline from envelope | Cancel; serve partial/cached; downgrade tier on retry | Skip deep enrichment, show standard card only |
| LLM 429 / rate limit | Gateway error | Exponential backoff + jitter; reroute to alt tier/region; open-weight fallback | Lower throughput, prioritize high-salience |
| LLM 5xx / provider outage | Error/circuit breaker | Circuit-break to fallback provider/open-weight; queue deep tasks | Hot path on fallback model; "explanations limited" banner |
| Worker crash | Heartbeat/lease expiry | Reschedule idempotent task on another node (F04) | Brief gap, auto-recovered via replay |
| Verification fails | Verdict | Suppress claim / mark unverified / regen once | Card without unsupported detail; "unverified" badge |
| Vector/graph store slow | Latency probe | Serve without recall (window-only context); async backfill graph | Less-grounded explanation; graph catches up |
| Event-bus lag/backpressure | Queue depth | Salience-shed low-priority tasks; coalesce | Fewer cards, transcript unaffected |
| Conductor failure | Lease/health | Failover Conductor rebuilds state from D08 replay + session-memory snapshot | Short pause, then resume |
| Cost ceiling hit (tenant) | Token accounting | Force-downgrade tiers, throttle deep path | "Eco mode": Haiku-only extraction, cached explanations |

### 9.2 Retry policy

| Class | Retries | Backoff | Idempotency |
|---|---|---|---|
| Transient (429/5xx/timeout) | up to 2 | exp + jitter, capped by remaining deadline | Yes — keyed `(session_id, seq, capability, attempt)` |
| Deterministic (bad schema) | 1 (with repair prompt) | immediate | Yes |
| Fatal (auth/quota exhausted) | 0 | — | Circuit-break + alert |

### 9.3 Degraded-mode ladder

```
FULL ─▶ NO-DEEP (skip research/Opus) ─▶ ECO (Haiku-only + cache) ─▶ TRANSCRIPT-ONLY
        (latency/load)                  (cost/rate limit)           (AI outage; F01 still live)
```

The UI (Team 6) reflects the current mode via a non-blocking banner; the **live
transcript and captions never stop** regardless of degradation.

---

## 10. Holding the D07 latency budget

D07 budget recap: capture+stream ≤500 ms · STT partial ≤800 ms · **extraction ≤700
ms · explanation first-token ≤1,000 ms** · render ≤300 ms → p50 ≤3 s. Orchestration
owns the **extraction + explanation** slices and must add minimal overhead.

| Lever | How orchestration applies it | Budget saved |
|---|---|---|
| **Parallelism** | Extraction, Insight, and Graph-incremental dispatched concurrently from the Conductor (fan-out); they don't serialize | Removes additive latency between tasks |
| **Streaming** | Explanation first token streams to UI immediately; examples/diagram/citations accrete after | Hits ≤1 s first-token; deep content best-effort |
| **Speculative execution** | On a *stable partial*, Triage + Extraction may start before finalization; discard if the final segment diverges | Shaves ~300–500 ms perceived |
| **Prompt caching** | Stable system/glossary prefix cached per tier | Cuts input latency + cost on every hot call |
| **Tiered routing** | Haiku for triage/salience/incremental graph keeps the common path sub-200 ms; escalate only on need | Keeps p50 low |
| **Explanation cache** | Known concept → serve cached explanation from long-term memory; skip the model | Near-zero latency on repeats |
| **Salience gate** | Skip extraction/explanation for low-value chatter; spend budget where it matters | Protects budget under load |
| **Off-hot-path work** | Research, summarization, full verification, evaluation never block first useful output | Hot path stays lean |
| **Deadline propagation** | Every task carries a deadline; workers self-cancel and serve partial rather than overrun | Bounds tail latency (p95 ≤5 s) |
| **Co-location / region affinity** | Conductor + workers + caches in same AZ/region (F04) to cut network hops | Trims overhead ms |

**Hot-path budget walkthrough (p50):**

```
 segment final ─┬─▶ Triage (Haiku) 150ms ─┬─▶ Extraction 500ms ─▶ ConceptCard draft (≈650ms)
                │                          └─(parallel)─▶ Insight 600ms
                │                          └─(parallel)─▶ Graph incr 250ms
                └─▶ Explanation Agent: first token ≤900ms (streams) ─▶ render ≤300ms
   Net: first useful card + first explanation token well inside the ~3s p50 envelope.
```

---

## 11. Technology recommendations

| Concern | Recommendation | Why (D04/D07/D08/D09) |
|---|---|---|
| Orchestration runtime | Stateful actor/workflow engine — **Temporal** (or a lightweight in-house Conductor on the event bus) for durable, retryable, idempotent tasks | Durable execution = clean retries/failover (§9); fits stateless-worker model |
| Conductor state | **Redis** (hot session state) + replay from event bus | Fast blackboard; rebuildable (D09) |
| Event backbone | **Kafka-compatible log (Event Hubs Dedicated)/Event Hubs** per session, ordered by `seq` | D08; ordered replay enables Conductor failover |
| LLM access | **LLM gateway** (routing, rate limits, caching, fallback, token accounting) in front of Anthropic Claude tiers + open-weight fallback | D04; central place to enforce tiers/budgets |
| Prompt caching | Provider prompt cache on stable prefixes | §5/§10 latency + cost |
| Memory/vector | pgvector (MVP) → dedicated vector DB at scale; Postgres + graph store | D09 |
| Observability | OpenTelemetry traces per `task_id`; latency-budget dashboards; eval pipeline | SLO adherence, §8.2 |
| Eval harness | LLM-as-judge + gold sets in CI | §8.2 |

---

## 12. Risks

| ID | Risk | L | I | Mitigation |
|---|---|---|---|---|
| OR-1 | Hot path blows D07 under load | Med | High | Salience gate, tiered routing, parallel fan-out, deadline self-cancel, autoscale (F04) |
| OR-2 | Hallucinated explanations reach users | Med | High | Verification gate, citations, confidence chips, regulated-domain forced verification |
| OR-3 | Cost runaway (over-using Opus) | Med | High | Default-Haiku routing, caches, per-tenant ceilings, eco mode (§9) |
| OR-4 | Provider outage / rate limits | Med | High | Multi-provider gateway, open-weight fallback, circuit breakers, degraded ladder |
| OR-5 | Conductor is a per-session SPOF | Low | High | Durable workflow engine + replay failover; stateless workers |
| OR-6 | Memory growth / context bloat → slow & costly | Med | Med | Rolling summaries, budgeted recall, bounded windows |
| OR-7 | Coreference/dedup errors fragment the graph | Med | Med | Entity registry in session memory; Sonnet reconcile pass |
| OR-8 | Privacy leak via long-term memory in no-retention mode | Low | High | Suppress long-term writes; ephemeral session memory; flag to F09 |

---

## 13. Scalability (against D02)

| Dimension | MVP (200 live) | Year-1 (5k live) | North-star (50k live) | Lever |
|---|---|---|---|---|
| Conductors | 200 (1/session) | 5,000 | 50,000 | Lightweight actors; many per node; autoscale (F04) |
| Hot-path LLM calls/s | low | thousands/s | tens of thousands/s | Tiered routing (mostly Haiku), caching, salience gate |
| Vector recall QPS | low | high | very high | pgvector → dedicated vector DB; cache hot concepts |
| Graph writes/s | low | high | very high | Incremental Haiku ops; batch reconcile |
| Cost driver | mostly Sonnet explanation | tier mix | tier mix + cache hit rate | Push cache-hit rate up; keep Opus rare |

Orchestration scales **horizontally** (stateless idempotent workers, per-session
Conductors); the binding constraints are LLM provider throughput (gateway + multi-
provider) and vector/graph store QPS (F04/F09 stores).

---

## 14. Security

| Concern | Control |
|---|---|
| Tenant isolation | Every task carries `tenant_id`; capabilities + stores enforce row/namespace isolation; no cross-tenant memory recall |
| Prompt injection (from transcript content) | Treat transcript as untrusted data, not instructions; capability prompts isolate user content; tool-use allowlists; verification catches injected claims |
| Secret/key handling | Keys only in F04-managed secret store + LLM gateway; **never** in prompts, logs, or this repo |
| Data minimization | Context Assembler sends only budgeted, need-to-know context; no raw audio to LLMs |
| Auditability | Per-`task_id` traces; which tier/provider saw what (for compliance, F09) |
| Retention | Memory tiers honor D10 retention; no-retention mode suppresses long-term writes |

(Authoritative security/compliance = F09; orchestration enforces its directives.)

---

## 15. Cost

| Lever | Effect on D02 cost math |
|---|---|
| Default-Haiku triage/salience/graph | Keeps the per-segment floor cost minimal |
| Sonnet hot explanation, Opus deep only | Most cost is Sonnet; Opus is rare/best-effort |
| Prompt caching + explanation cache | Largest single cost reducer at scale (repeated concepts/prefixes) |
| Salience gate | Avoids paying to explain low-value chatter |
| Per-tenant ceilings + eco mode | Bounds worst-case spend; protects margins |

> Concrete token/$ math is owned by F02 (capability internals) and F04 (infra). This
> lane provides the **routing/caching policy** that determines tier mix and cache-hit
> rate — the dominant cost levers.

---

## 16. MVP scope

**In:** Conductor + hot path (Triage→Extraction→Explanation std→Insight→Graph
incremental), light verification, rolling+final summarization, session+short-term
memory, tiered routing (Haiku/Sonnet, Opus for deep-on-demand), retries/timeouts/
fallback + degraded ladder, basic eval (latency SLO + user feedback).

**Out (post-MVP):** full research deep path at scale, cross-session long-term
personalization/profile summarizer, open-weight self-host path, advanced LLM-judge
eval suite, speculative execution on partials (add once hot path is stable).

---

## 17. Future enhancements

- Speculative/streaming execution on stable partials for sub-2 s perceived latency.
- Reinforcement from user feedback (👍/👎) into routing + prompt selection.
- On-device Haiku-class triage for privacy/latency on desktop.
- Multi-agent debate/critique for high-stakes (legal/medical) explanations.
- Adaptive budgets per user/domain; predictive prefetch of likely-next concepts.
- Open-weight self-host orchestration for enterprise air-gapped deployments.

---

## 18. Assumptions

| ID | Assumption |
|---|---|
| AO-1 | F02 exposes named capabilities (Extraction, Explanation, ResearchRetrieval, GraphBuild, InsightExtraction, Embedding) as typed `in→out` (streamable) services emitting D06 contract objects. |
| AO-2 | Explanation capability supports streaming (first-token) and a depth/reading-level parameter (or regenerates per depth — OQ in Team 6). |
| AO-3 | F04 provides a durable, ordered, per-session event stream (D08) with replay + snapshot, plus Redis/vector/graph/Postgres stores (D09) and autoscaling. |
| AO-4 | An LLM gateway provides tier routing, rate-limit handling, caching, fallback, and token accounting. |
| AO-5 | Capabilities are idempotent enough to retry by `(session_id, seq, capability)`. |
| AO-6 | Open-weight fallback implements the same capability interface (D04). |

---

## 19. Decisions (orchestration-local; honor D01–D12)

| ID | Decision |
|---|---|
| OR-D1 | Hierarchical Session Conductor + stateless idempotent workers; durable workflow engine for retry/failover. |
| OR-D2 | Two clocks: hot path fits D07; deep path best-effort ≤10 s. |
| OR-D3 | Tiered routing per D04: Haiku default, Sonnet hot, Opus deep-only; open-weight fallback. |
| OR-D4 | Verification gate guards every user-facing claim; confidence + citations always attached. |
| OR-D5 | Three memory tiers; bounded context via rolling summaries + budgeted recall + prompt caching. |
| OR-D6 | Live transcript (F01) is never blocked by AI failure; degrade via a defined ladder. |
| OR-D7 | Orchestrate F02 by named capability only; never reimplement AI internals. |

---

## 20. Tradeoffs

| Tradeoff | Chosen | Alternative | Why |
|---|---|---|---|
| Hierarchical supervisor vs flat peer agents | Hierarchical Conductor | Flat/autonomous swarm | Predictable latency, budget control, easier failure recovery |
| Durable workflow engine vs ad-hoc queue | Durable (Temporal-class) | Plain queue + custom retry | Idempotent retries/failover for free; worth the dependency |
| Speculative on partials vs wait for final | Wait at MVP, speculate later | Always speculate | Avoid wasted spend/complexity until hot path proven |
| Inline vs offline verification | Light inline + full offline/deep | All inline | Inline-everything blows D07; sample + gate critical claims |
| One model vs tiered | Tiered (D04) | Single Sonnet | Cost/latency; cheap path dominates volume |
| Per-session Conductor vs shared | Per-session | Shared multiplexer | Isolation, simpler state, scales horizontally |

---

## 21. Open questions

| ID | Question | Owner |
|---|---|---|
| OQ-7 | Exact capability signatures + streaming semantics from F02. | F02 |
| OQ-8 | Does the explanation capability accept a depth/reading-level param, or must orchestration regenerate per depth? | F02 |
| OQ-9 | Event-bus replay/snapshot API for Conductor failover — shape from F04? | F04 |
| OQ-10 | Will F04 ship a shared LLM gateway, or does this lane own routing/caching/fallback? | F04 |
| OQ-11 | Coreference/entity-resolution ownership — F02 GraphBuild vs orchestration session registry? | F02 |
| OQ-12 | Cost-ceiling enforcement point — gateway (F04) vs Conductor policy? | F04 |

---

## 22. Estimated complexity

| Component | Complexity | Driver |
|---|---|---|
| Session Conductor + supervision | **High** | Stateful, latency-critical, failover |
| Tiered routing + LLM gateway integration | High | Tier logic, caching, fallback, accounting |
| Memory tiers + context assembler | High | Bounded context, recall, privacy modes |
| Hot-path parallel fan-out + budget enforcement | **High** | Hitting D07 reliably under load |
| Summarization pipelines | Medium | Hierarchical map-reduce |
| Verification agent (inline + full) | Medium-High | Grounding checks within budget |
| Evaluation harness | Medium | Judges, gold sets, dashboards |
| Failure recovery / degraded ladder | High | Many failure modes, must never block transcript |
| Deep/research path | Medium | Off hot path, best-effort |

**Overall lane-orchestration complexity: High** — a durable, latency-bounded, multi-
tier multi-agent system with strong failure isolation is the hardest part of the
runtime, on par with the capture/STT and intelligence-core lanes.
