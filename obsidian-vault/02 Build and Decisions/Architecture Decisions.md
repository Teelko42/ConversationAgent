---
title: Architecture Decisions
aliases: [Decisions, DECISIONS, D01-D20, Decision Ledger]
tags: [process, reference, architecture]
created: 2026-06-05
---

# Architecture Decisions

The authoritative, version-controlled decisions ledger lives at
`docs/architecture/00-integration/DECISIONS.md`. It holds the shared conventions every
[[System Architecture|lane]] must honor so separately-built parts integrate without
conflict. It was promoted in-tree from the ClaudeTrees run ledger (see
[[How It Was Built - ClaudeTrees]]). This note summarizes it; the [[Glossary]] decodes
the prefixes.

> [!info] How to read it
> Decisions are a **dated log, newest at the bottom**. Later decisions **refine or
> supersede** earlier defaults — each cites the doc that changed it. The user may
> override any decision.

---

## D01–D12 — run-wide conventions (2026-05-31)

| ID | Decision |
|---|---|
| **D01** | Product = **Aizen**, a real-time conversation-intelligence copilot. "AI explains the room." |
| **D02** | Scale targets: MVP 1k MAU / ~200 concurrent → Year-1 100k MAU / ~5k → North-star 2M / ~50k. |
| **D03** | Default cloud = **Azure**; primary region eastus, zone-redundant; westus DR; westeurope for EU. |
| **D04** | LLM = **Anthropic Claude** (Opus deep / Sonnet hot path / Haiku routing). Open-weight for self-host. → [[The LLM Gateway]] |
| **D05** | **Streaming STT** as the hot path; diarization owned by the transcription lane. → [[Audio Capture and STT]] |
| **D06** | **Canonical contract names are fixed** (AudioFrame, TranscriptSegment, ConceptCard, KG*, InsightItem). → [[Data Contracts]] |
| **D07** | End-to-end latency budget: p50 ≤ 3 s, p95 ≤ 5 s; deep dives ≤ 10 s. *(split later rebuilt by D17.)* |
| **D08** | Treat the pipeline as an **event-streaming system** (Kafka-class + WebSocket/WebRTC). |
| **D09** | Datastores: Postgres (+pgvector), graph store, Blob, Redis. |
| **D10** | **Privacy & consent are first-class** — per-session consent, retention, no-audio-retention mode. *(re-modeled by D18–D20.)* |
| **D11** | Platforms: web (primary), desktop (system audio), mobile; thin client + heavy server. |
| **D12** | Every lane doc must contain a fixed section set (architecture, risks, cost, MVP scope, …). |

---

## D13–D16 — integration decisions (2026-05-31, conductor)

| ID | Decision |
|---|---|
| **D13** | Event backbone = **Azure Event Hubs at MVP → Kafka-compatible log at Year-1**, behind a thin `EventBus` partitioned by `session_id`. Guarantee: durable, ordered, replayable per-session stream. → [[The Event Bus]] |
| **D14** | Datastores confirmed + **Cosmos DB** added for idempotency/dedup keys + append-only audit. |
| **D15** | **F04 owns the LLM gateway** (routing, prompt-cache, fallback, cost accounting, rate limits). F03/F07 consume it, never call providers directly. → [[The LLM Gateway]] |
| **D16** | **The F01↔F02 transcript seam.** F01's `TranscriptSegment` is authoritative; F02 adapts at ingress (ms→µs, unwrap `speaker.*`, rename `language`→`lang`, treat `segment_id` as opaque). → [[Correction Seams]] |

---

## D17–D20, INV-8/9 — validation remediation (2026-06-01)

These came from an **adversarial validation review** (`09-validation-review.md`) that
found the original design was *too confident* — some seams were assigned but never
designed, and two numbers (latency, cost) didn't add up. The remediation:

> [!warning] D16 amendment (closes H-7/H-8)
> The F01→F02 adapter **must also carry `rev` and `supersedes`** (the original field map
> silently dropped them, breaking correction semantics — the [[How It Was Built - ClaudeTrees|hidden disagreement bug]]).
> It now also takes a `ConsentContext` and stamps `consent_class`/`pii_present`
> **fail-closed** (missing ⇒ `sensitive` + `pii_present=true`). → [[Correction Seams]]

| ID | Decision |
|---|---|
| **INV-8** | **No live citation of superseded text.** Adds a `retracted` state + `retraction{}` to ConceptCard so the UI can un-render. → [[Correction Seams]] |
| **D17** | Extraction trigger = **speculative on a stabilized partial** (≥300 ms unchanged, salience-gated), reconciled on final. Finals-only is the degraded fallback. The **salience+stability gate is the shared control point for both latency and cost**. → [[The LLM Gateway]] |
| **D18** | **Consent is per-speaker**, not a session scalar. All-party capture requires per-track audio else it blocks the mixed stream. → [[Consent and Privacy]] |
| **D19** | Meeting-bot gated to **single-party jurisdictions** at MVP; disclosure ≠ consent. |
| **D20** | The **PII gate is fail-closed** with a named classifier; recall ≥ 0.95 PII / ≥ 0.98 PHI; missing/errored ⇒ `pii_present=true`. → [[Consent and Privacy]] |
| **INV-9** | The cross-session evidence cache **holds no personal data** (only generic reference content), making it DSAR-exempt by construction. |

> [!danger] Cost-model correction (RISK-1)
> Rebuilt bottom-up, MVP unit cost is **~$3.5/session-hr** (not the original $2.00),
> realistic Pro margin at documented usage is **negative-to-thin**, and the product must
> **never sell "unlimited."** A bounded hour pool + overage and a cost dashboard are P0.

---

## Build Decisions (BD) — engineering conventions for the spine

These are referenced throughout the code comments (in `.claudetrees/.../DECISIONS.md`):

| ID | Decision | Where it shows up |
|---|---|---|
| **BD-01** | One per-session **ordered event bus**; `seq` is the bus's to mint, never a producer's. | [[The Event Bus]] |
| **BD-03** | Every vendor sits behind a **seam** with a deterministic Stub + a real adapter; chosen by key presence, no branching at call sites. | everywhere |
| **BD-04** | Only the conductor imports other lanes' public exports; lanes code against the bus + contracts. | [[Correction Seams]] |

---

## Still pending (manual / legal, not design)

State-by-state consent matrix (OQ-SEC-3), sub-processor DPAs/BAAs + STT zero-retention
contract (OQ-SEC-1/2), negotiated Anthropic/Deepgram rate cards (MAN-F05-002), PII
eval-set construction, DPIA, and the live Azure `terraform apply` (**MAN-F04-001**). The
architecture is parameterized to accept these answers without rework.

---

## Related
- [[The Blueprint Documents]] — the docs these decisions reference
- [[How It Was Built - ClaudeTrees]] — where the ledger came from
- [[Glossary]] — the ID-prefix legend
