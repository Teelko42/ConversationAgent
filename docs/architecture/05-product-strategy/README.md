# 05 — Product Strategy (Lane F05)

> **Aizen** — "AI explains the room." This lane defines the **business** around
> the real-time conversation-intelligence platform that lanes F01–F04 design:
> who buys it, why, how it makes money, what ships first, and the next 12 months.
> It is a product/business strategy, **not** a technical design — it references
> F01–F04 capabilities **by name only** and never redesigns them.

## Scope (Team 10 — Product Strategy)

Covers the user-brief Team 10: target users & personas, market & competitive
analysis, monetization, MVP definition + feature prioritization, and a 12-month
roadmap consistent with the D02 scale targets.

## Documents

| File | Contents |
|---|---|
| [`team-10-product-strategy.md`](./team-10-product-strategy.md) | The full strategy: all D12 sections + personas/segments, TAM/SAM/SOM, competitive table, pricing tiers + unit economics, MoSCoW/RICE MVP, 12-month quarterly roadmap. |
| `README.md` (this file) | Lane overview, key conclusions, dependencies, manual tasks. |

## Key conclusions (TL;DR)

- **Wedge / differentiation:** competitors transcribe and *summarize after the
  fact*; Aizen **explains and teaches the conversation live** (the F02
  explain-and-teach engine on top of the F01 real-time transcript). That is the
  one thing nobody else makes their primary motion.
- **Beachhead:** individual high-context knowledge workers — consultants, sales
  engineers, cross-functional KWs — US/English-first. Students and regulated
  verticals are secondary/later.
- **Motion:** PLG-first (meeting-bot virality, self-serve), sales-assisted
  Enterprise added in Q4 once F04/Team 9 compliance (SSO, audit, retention,
  HIPAA, residency) matures.
- **Pricing:** Free $0 (hard-capped) · **Pro $20** · **Team $30** · Enterprise
  custom. ~65% gross margin at Pro MVP, trending to 75%+ at scale via STT
  self-host + explanation caching.
- **MVP (D02 1k MAU / ~200 concurrent):** F01 capture + transcript, F02 extract +
  explain-and-teach, F03 web+desktop UX + orchestration hot path, F04 consent +
  multi-tenant core, plus Insights and lite Research. Web+desktop, English-first;
  mobile/multi-language/HIPAA deferred.
- **12-month arc:** Q1 beta (1k MAU) → Q2 PLG launch + virality → Q3 Team tier +
  mobile → Q4 Enterprise/regulated reaching **D02 Year-1 100k MAU / ~5k
  concurrent**, $500k–$1M ARR run-rate, Series-A-ready.

## Dependencies (referenced by name only — no files edited)

- **F01** Capture & Transcription — `AudioFrame`, `TranscriptSegment`, meeting-bot
  join, system-audio, STT cost driver.
- **F02** Intelligence Core — `ConceptCard`, knowledge graph, `InsightItem`, the
  explain-and-teach engine, research/citations, LLM cost driver.
- **F03** Experience & Orchestration — UX surfaces, mobile (D11), the runtime
  brain and failure recovery.
- **F04** Platform & Security/Compliance — scale/cost basis, SSO/audit/retention/
  HIPAA/residency that gate Enterprise packaging.
- Shared conventions: **D02** (scale anchors), **D04** (LLM tiering → margins),
  **D05** (STT → COGS), **D10** (consent → Enterprise + lawful MVP), **D11**
  (platforms → MVP/roadmap), **D12** (doc structure).

## Manual user tasks

Human-only follow-ups are logged in this lane's
`features/F05-product-strategy/MANUAL.md` and appended to the run-level
`NEEDS_USER.md` with IDs **MAN-F05-001 … MAN-F05-005** (market-research/analyst
data, STT/LLM rate-card confirmation, billing provider decision, design-partner
interviews, pricing/legal sign-off). No secrets are written.

## What this lane does NOT do

No technical system design (F01–F04 own that), no infra/cost provisioning, no
implemented code. This lane consumes those designs to prioritize, package, and
monetize.
