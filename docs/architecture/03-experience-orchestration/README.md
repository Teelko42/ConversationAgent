# 03 — Experience & Agent Orchestration (Lane F03)

> **Aizen** — "AI explains the room." This lane designs **what the user touches**
> and **the runtime multi-agent brain** that drives it. It covers the user brief's
> **Team 6 (User Experience)** and **Team 7 (AI Agent Orchestration)**.
>
> This lane **renders the F01/F02 data contracts by name only** and **orchestrates
> the F02 AI capabilities by name only** — it does not redesign F02 AI internals,
> F01 capture/STT, or F04 infrastructure.

## Documents

| Doc | Team | Covers |
|---|---|---|
| [`team-06-user-experience.md`](./team-06-user-experience.md) | Team 6 | UX architecture, primary workflows, user journeys, ASCII wireframes (live transcript, concept cards, topic explorer, interactive explanations, timeline, knowledge graph), desktop/mobile/web UX, WCAG 2.2 AA accessibility, live vs review modes |
| [`team-07-agent-orchestration.md`](./team-07-agent-orchestration.md) | Team 7 | Agent hierarchy, agent-to-agent communication, memory tiers, context management, task routing (model tier per task, D04), summarization pipelines, verification & evaluation agents, failure recovery, holding the D07 latency budget |

Each team doc contains all **D12** sections: Architecture · Technology
recommendations · Risks · Scalability · Security · Cost · MVP scope · Future
enhancements · Assumptions · Decisions · Tradeoffs · Open questions · Estimated
complexity.

## How the two halves connect

The orchestration layer (Team 7) is the **producer**; the experience layer (Team 6)
is the **consumer**. They meet at the **D06 contract objects** flowing over the
**D08 per-session event stream**.

```
  F01 ───TranscriptSegment───▶ ┌──────────── F03 / Team 7: ORCHESTRATION ───────────┐
  (capture/STT)                │  Session Conductor → tiered agents → F02 capabilities│
                               │  (Extraction · Explanation · Research · Graph ·       │
  F02 capabilities ◀──called──▶│   Insight) → verification gate                        │
  (by name)                    └───────────────┬──────────────────────────────────────┘
                                               │ emits (D08 event stream, ordered by seq)
                                ConceptCard · KnowledgeGraphNode/Edge · InsightItem
                                               │
                               ┌───────────────▼──────────────── F03 / Team 6: EXPERIENCE ─┐
                               │  Thin reactive client (web · desktop/Tauri · mobile/RN)    │
                               │  Transcript · Cards · Explorer · Explanation · Timeline ·   │
                               │  Graph · Insights — WCAG 2.2 AA · Live & Review modes       │
                               └─────────────────────────────────────────────────────────────┘
   User commands (explain deeper · pin · scrub · redact) ───▶ back to Conductor (deep path)
```

## Contracts rendered & capabilities orchestrated (by name only)

| Object (D06) | Owner | F03 role |
|---|---|---|
| `TranscriptSegment` | F01 | Orchestration consumes as the task trigger; UI renders as live transcript/captions |
| `ConceptCard` | F02 | Produced via Explanation/Extraction capabilities; UI renders as cards + explanations |
| `KnowledgeGraphNode/Edge` | F02 | Produced via GraphBuild capability; UI renders graph + list-view mirror |
| `InsightItem` | F02 | Produced via InsightExtraction capability; UI renders insights/action items |

| F02 capability (by name) | Orchestrated by |
|---|---|
| `ExtractionCapability`, `ExplanationCapability`, `ResearchRetrievalCapability`, `GraphBuildCapability`, `InsightExtractionCapability`, `EmbeddingCapability` | Team 7 agents (tiered per D04) |

## Decisions honored

D01 (Aizen framing) · D04 (Claude tiers: Haiku route/classify, Sonnet hot path,
Opus deep) · D06 (contract names) · D07 (latency budget — Team 7 owns
extraction+explanation slices, Team 6 owns the ≤300 ms render slice) · D08 (event
backbone) · D09 (datastores back the memory tiers) · D10 (consent/privacy UI +
memory retention) · D11 (web primary, desktop, mobile) · D12 (doc structure).

## Out of scope (other lanes)

- F02 AI capability internals (extraction/explanation/RAG reasoning).
- F01 audio capture / STT / diarization.
- F04 cloud infra, event-backbone implementation, datastore ops, scaling, DR.
- F09 authoritative consent/privacy/compliance model (this lane surfaces and
  enforces it in UI + memory).

## Manual tasks raised by this lane

See `NEEDS_USER.md` / `MANUAL.md` (IDs `MAN-F03-001`…`MAN-F03-005`): design-tool
accounts, brand/visual identity, accessibility-audit vendor, app-store presence,
plus an LLM-provider account/keys touchpoint for the orchestration LLM gateway.
