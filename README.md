# Aizen — AI Conversation Intelligence Platform

> **A real-time copilot that listens to a live conversation and explains and
> teaches everything being discussed** — transcript, concepts, jargon,
> assumptions, sourced background, action items, and a live knowledge graph —
> across software, finance, healthcare, legal, science, sports, meetings, and
> interviews. *"AI explains the room."*

This repository holds the **complete technical architecture and product
blueprint** for Aizen — production-grade design documents from a ten-team /
five-lane architecture exercise, an adversarial validation + remediation pass
(docs 09–13), and the **Phase 0 foundation code** that builds against the
hardened spec.

## Start here

- **[Executive Summary](docs/architecture/00-integration/08-executive-summary.md)** — the one-page read.
- **[Integration index](docs/architecture/00-integration/README.md)** — unified/MVP/scaling architecture, phased plan, staffing, risks, validation + remediation.
- **[Phase 0 code](#phase-0--foundation-code)** — the TypeScript monorepo (contracts, seams, gateway) + Terraform skeleton.

## The blueprint

```
docs/architecture/
├── 00-integration/                  # CONDUCTOR — unified blueprint (read first)
│   ├── 01-conflicts-and-resolutions.md
│   ├── 02-unified-architecture.md
│   ├── 03-mvp-architecture.md
│   ├── 04-scaling-architecture.md
│   ├── 05-phased-implementation-plan.md
│   ├── 06-staffing-plan.md
│   ├── 07-technical-risk-assessment.md
│   └── 08-executive-summary.md
├── 01-capture-transcription/        # Teams 1–2: audio → transcript
│   ├── team-01-audio-capture-streaming.md
│   ├── team-02-speech-recognition-diarization.md
│   └── data-contracts.md            # AUTHORITATIVE AudioFrame, TranscriptSegment
├── 02-intelligence-core/            # Teams 3–5: understand, teach, evidence
│   ├── team-03-knowledge-extraction.md
│   ├── team-04-explanation-engine.md
│   ├── team-05-research-retrieval.md
│   └── data-contracts.md            # AUTHORITATIVE ConceptCard, KnowledgeGraph*, InsightItem
├── 03-experience-orchestration/     # Teams 6–7: UX + multi-agent runtime
│   ├── team-06-user-experience.md
│   └── team-07-agent-orchestration.md
├── 04-platform-security/            # Teams 8–9: AWS platform + trust
│   ├── team-08-infrastructure-platform.md
│   └── team-09-security-privacy-compliance.md
└── 05-product-strategy/             # Team 10: market, pricing, roadmap
    └── team-10-product-strategy.md
```

## How the system fits together

```
Capture (F01·T1) → Transcribe (F01·T2) → Understand (F02·T3) → Teach (F02·T4)
        → Evidence (F02·T5) → Experience (F03·T6), all routed by
        Orchestration (F03·T7), hosted+secured by Platform/Trust (F04·T8/T9),
        packaged by Product (F05·T10).
```

Everything rides **one per-session ordered event stream** and is glued by **five
versioned data contracts** (`AudioFrame`, `TranscriptSegment`, `ConceptCard`,
`KnowledgeGraph*`, `InsightItem`). Each lane owns a disjoint area; the only
cross-lane couplings are those contracts plus four integration decisions
(D13–D16). See [conflicts & resolutions](docs/architecture/00-integration/01-conflicts-and-resolutions.md).

## Headlines

| | |
|---|---|
| **Wedge** | Live *explain-and-teach*, not after-the-fact summaries |
| **Latency** | speech → first useful card p50 ≤ 3 s / p95 ≤ 5 s; deep dives ≤ 10 s |
| **Stack** | AWS · Kinesis→MSK · Aurora+pgvector→Neptune · Claude Haiku/Sonnet/Opus · WebRTC |
| **Cost** | $2.00/session-hr (MVP) → $0.47 (scale); margin plan = the self-host curve |
| **MVP** | Web+desktop, Zoom join, transcribe+explain+insights, consent, Free+Pro — 1k MAU |
| **Timeline** | ~18 wks to beta, ~26 to GA; ~11–13 → ~22–27 people |
| **Top risk** | Unit economics (RISK-1) — never sell "unlimited" |

## Phase 0 — foundation code

The vendor-free slice of Phase 0 (doc 05) — the parts that need no AWS/Anthropic/
Deepgram account — is implemented and tested. It builds directly against the
hardened spec (D16-amend, D17, INV-8, D20, INV-9) and exists to make those
decisions executable rather than prose.

```
packages/                      # pnpm + TypeScript monorepo
  contracts/                   # @aizen/contracts — the 5 canonical contracts (D06)
    src/*.ts                   #   zod schemas + inferred types (incl. retracted state,
    schema/*.schema.json       #   ConsentContext, kg_snapshot/resync) → JSON Schema registry
  adapter-d16/                 # Seam A — pure F01→F02 adapter (rev/supersedes, fail-closed)
  seam-supersede/              # Seam B / INV-8 — provenance index, re-extract/retract
  seam-kg-resync/              # Seam C — delta_seq↔Position index, resync decision tree
  llm-gateway/                 # D15 skeleton — tier routing, cost ceilings, D17 gate (stubbed)
infra/                         # Terraform skeleton — MVP topology (no live deploy; MAN-F04-001)
```

**Run it** (pnpm via corepack):

```bash
corepack pnpm@9.7.0 install
corepack pnpm@9.7.0 test          # 34 contract tests (CT-A*, CT-B*, CT-C*, CT-M2, gateway)
corepack pnpm@9.7.0 typecheck
corepack pnpm@9.7.0 --filter @aizen/contracts run export-schema   # regenerate the registry
```

The six contract-test suites (doc 10 §1.5/§2.6/§3.6) are executable specifications:
they encode the H-7/H-8/H-9/H-13 fixes as regression guards. **Next** Phase-0 work
is vendor-gated (AWS org, Deepgram, Anthropic — the `NEEDS_USER.md` accounts):
the STT integration, the real LLM providers, and `terraform apply`.

## How this blueprint was produced

Built with **ClaudeTrees**: one conductor sliced the brief's ten teams into five
independent lanes, dispatched five parallel background workers (each owning a
disjoint `docs/architecture/` directory and coordinating only through a shared
markdown bus), a scribe consolidated all human-action items, and the conductor
integrated the results under review. Orchestration scaffolding lives (git-ignored)
under `.claudetrees/`; outstanding human actions are in
`.claudetrees/runs/<run>/NEEDS_USER.md` (**27 tasks, 10 High**).
