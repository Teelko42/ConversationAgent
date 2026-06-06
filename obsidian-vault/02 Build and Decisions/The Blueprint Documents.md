---
title: The Blueprint Documents
aliases: [Blueprint, docs/architecture, Design Docs]
tags: [process, reference, architecture]
created: 2026-06-05
---

# The Blueprint Documents

Before any code, the project produced a **full technical architecture** — an
architect's drawings before the building. It lives in `docs/architecture/` and is the
plan the [[System Architecture|code]] was built against. It set the names, tools, and
speed targets the code later followed (which is *why* separately-built parts fit), and
it was honest enough to find and fix its own holes. See
[[How It Was Built - ClaudeTrees]] for how it was produced.

> [!note] A plan, not a building
> Detailed and useful — but on its own it is **zero working software**. Its real value
> wasn't being perfect; it was being thorough enough to catch its own gaps before code
> was built on them (the validation pass, docs 09–13).

---

## Two layers

**The detailed lane docs** — one set per area, each covering the same fixed topics
(architecture, tech recommendations, risks, scalability, security, cost, MVP scope,
future work, assumptions, decisions, tradeoffs, open questions, complexity — that's
**D12**):

```
docs/architecture/
├── 01-capture-transcription/     # F01: audio → transcript
│   ├── team-01-audio-capture-streaming.md
│   ├── team-02-speech-recognition-diarization.md
│   └── data-contracts.md         # AUTHORITATIVE AudioFrame, TranscriptSegment
├── 02-intelligence-core/         # F02: understand, teach, evidence
│   ├── team-03-knowledge-extraction.md
│   ├── team-04-explanation-engine.md
│   ├── team-05-research-retrieval.md
│   └── data-contracts.md         # AUTHORITATIVE ConceptCard, KG*, InsightItem
├── 03-experience-orchestration/  # F03: UX + multi-agent runtime
│   ├── team-06-user-experience.md
│   └── team-07-agent-orchestration.md
├── 04-platform-security/         # F04: Azure platform + trust
│   ├── team-08-infrastructure-platform.md
│   └── team-09-security-privacy-compliance.md
└── 05-product-strategy/          # F05: market, pricing, roadmap
    └── team-10-product-strategy.md
```

**The "put it all together" layer** (`00-integration/`) — the conductor's unified
blueprint (read first):

| Doc | What it is |
|---|---|
| `01-conflicts-and-resolutions.md` | where lanes disagreed and how it was resolved |
| `02-unified-architecture.md` | the single combined design |
| `03-mvp-architecture.md` | the small starter version |
| `04-scaling-architecture.md` | how it grows (and the scaling triggers) |
| `05-phased-implementation-plan.md` | the step-by-step build plan (Phase 0 → …) |
| `06-staffing-plan.md` | who you'd hire (~11–13 → ~22–27 people) |
| `07-technical-risk-assessment.md` | the main risks (RISK-1 = unit economics) |
| `08-executive-summary.md` | the one-page read |
| `DECISIONS.md` | the in-tree decisions ledger → [[Architecture Decisions]] |

---

## The validation + remediation pass (docs 09–13)

The standout feature of the blueprint is that it **audited itself**. An adversarial
review found the early "no problems, fully consistent" claim was overconfident, and
produced four remediation docs that became [[Architecture Decisions|D17–D20 / INV-8/9]]:

| Doc | Fixes |
|---|---|
| `09-validation-review.md` | the adversarial findings (H-2, H-7, H-8, H-10…H-13, M-9, C-7…) |
| `10-seam-contracts.md` | **Seam A/B/C** — the F01→F02 adapter, supersede propagation, KG resync → [[Correction Seams]] |
| `11-cost-model.md` | rebuilt bottom-up cost (~$3.5/session-hr; RISK-1) |
| `12-latency-budget.md` | rebuilt p50+p95 budget; speculative-on-partial trigger (D17) |
| `13-consent-and-privacy-redesign.md` | per-speaker consent (D18), fail-closed PII (D20) → [[Consent and Privacy]] |

> [!example] What the review caught
> Two key numbers (latency split and cost) **didn't add up** when checked, and a few
> seams had been *assigned to a lane but never actually designed*. The remediation docs
> filled exactly those gaps — and the seam contracts directly produced the working
> [[Correction Seams|adapter / supersede / resync packages]].

---

## How the blueprint shaped the code

- **It set the rules** — names ([[Data Contracts|D06]]), tools (Claude/Deepgram/Azure),
  and speed targets (D07). Round 2 didn't re-decide any of it.
- **It set the finish lines** — the Phase-0 goal came straight out of
  `05-phased-implementation-plan.md`.
- **It is honest about its own mistakes** — the value was catching and fixing its holes
  before anyone built on them.

---

## Related
- [[Architecture Decisions]] — the ledger these docs reference
- [[How It Was Built - ClaudeTrees]] — the process that wrote them
- [[Correction Seams]] — the code that the seam-contract doc produced
- [[Consent and Privacy]] — the code-side of doc 13
