---
title: Glossary
aliases: [Glossary, Terms, Decision IDs, Acronyms]
tags: [overview, reference]
created: 2026-06-05
---

# Glossary

A decoder for the terms, acronyms, and ID prefixes that recur across the Aizen
codebase and docs. For the full text of the decisions, see [[Architecture Decisions]].

---

## ID prefixes (what the labels mean)

| Prefix | Meaning | Example |
|---|---|---|
| **F01–F05** | the five **lanes** (groups of teams) the work was split into | F02 = the AI core |
| **D01–D20** | run-wide **Decisions** every lane must honor | D16 = the F01↔F02 transcript seam |
| **BD-01…04** | **Build Decisions** — engineering conventions for the spine | BD-03 = the stub/real seam |
| **INV-x** | **Invariants** that must always hold | INV-8 = no live citation of superseded text |
| **H-x / M-x / C-x** | hazards / medium findings / conflicts from the validation review | H-7 = adapter dropped `rev`/`supersedes` |
| **RISK-1** | the project's #1 risk: unit economics | "never sell unlimited" |
| **MAN-Fxx-xxx** | a **manual** task needing a human (sign-up, legal, key) | MAN-F04-001 = get an Azure subscription |
| **OQ-x** | open questions deferred (often legal) | OQ-SEC-3 = state-by-state consent matrix |
| **T1–T6 / C1–C4** | trust tiers (sources) / consent-sensitivity classes | — |
| **Fn §x** | a section of a feature spec in `New_Feature.md` | F4 §5 = Obsidian citations |

---

## Core domain terms

| Term | Meaning |
|---|---|
| **Lane** | one of the five parallel work areas (F01–F05). See [[System Architecture]]. |
| **Session** | one live conversation. Everything is scoped by `session_id`. |
| **Tenant** | the billing/isolation owner; every envelope carries `tenant_id`. |
| **Envelope** | a message on the bus — either **F01** (audio/transcript) or **F02** (intelligence). See [[Data Contracts]]. |
| **seq** | a monotonic per-session, per-class ordering number minted by the [[The Event Bus|bus]]. |
| **Seam** | a vendor-neutral interface with a deterministic Stub + a real adapter (**BD-03**). |
| **Spine** | the deterministic A→D chain (`MockClipSource → StubStt → runIntel`) run by the conductor. |
| **Provenance** | which transcript segment(s) an artifact cites — tracked so corrections can retract it. |

---

## The five canonical [[Data Contracts]]

| Contract | What it is | Owned by → consumed by |
|---|---|---|
| **AudioFrame** | a timestamped chunk of captured audio + session/speaker meta | F01 produces |
| **TranscriptSegment** | speaker-attributed, timestamped, confidence-scored text span | F01 → F02 (the **D16** seam) |
| **ConceptCard** | an extracted concept/entity/acronym + explanation + citations + graph link | F02 → F03 |
| **KnowledgeGraphNode / Edge** | the live conversation knowledge graph | F02 → F03 |
| **InsightItem** | an action item / decision / open question | F02 → F03 |

Feature-era additions: **SentenceExplanation**, **FollowupAnswer**, **UserSource**,
**Account / Identity / Entitlement / SavedSession / StoredSource / StoredArtifact**.

---

## Vendors & technologies

| Name | Role | Where |
|---|---|---|
| **Anthropic Claude** (Haiku/Sonnet/Opus) | the LLM tiers (route/extract → Haiku, enrich → Sonnet, deep → Opus) | [[The LLM Gateway]] |
| **Deepgram** | streaming speech-to-text + word-level diarization | [[Audio Capture and STT]] |
| **Tavily** | web search for grounding answers (citations) | [[The Intelligence Engine]] |
| **Google / Microsoft Entra** | OAuth (Authorization-Code + PKCE) sign-in | [[The Account System]] |
| **zod** | runtime schema validation → inferred TS types | [[Data Contracts]] |
| **pnpm / tsx / Vitest** | package manager / TS runner / test runner | [[Deployment and Testing]] |
| **Azure** | the cloud target (Event Hubs, Postgres+pgvector, Redis, Blob, Container Apps) | [[Deployment and Testing]] |
| **node:sqlite / PostgreSQL** | the swappable accounts store | [[The Account System]] |
| **File System Access API** | browser folder picker behind the Obsidian connector | [[F4 - Obsidian Vault Connection]] |
| **BM25** | the lexical retrieval algorithm for BYO sources | [[S0 - Source Library and Retrieval]] |
| **ClaudeTrees** | the multi-agent orchestration that produced the repo | [[How It Was Built - ClaudeTrees]] |

---

## The decisions you'll see most often

- **D04** — Claude tier strategy (Haiku / Sonnet / Opus by task). → [[The LLM Gateway]]
- **D06** — fixed names for the canonical contracts. → [[Data Contracts]]
- **D07** — the end-to-end latency budget (p50 ≤ 3 s / p95 ≤ 5 s).
- **D15** — the LLM gateway owns routing, cost, and rate-limiting. → [[The LLM Gateway]]
- **D16** — the F01→F02 transcript seam (+ its amendment carrying `rev`/`supersedes`). → [[Correction Seams]]
- **D17** — extract speculatively on stabilized partials, reconcile on final.
- **D18–D20** — consent is **per-speaker** and **fail-closed** with a PII classifier. → [[Consent and Privacy]]
- **BD-01** — one ordered event bus per session. → [[The Event Bus]]
- **BD-03** — the stub/real provider seam. → everywhere
- **INV-8** — no live citation of superseded text. → [[Correction Seams]]

---

## Related
- [[Architecture Decisions]] — the authoritative, full-text ledger
- [[Aizen Home]] — back to the map
