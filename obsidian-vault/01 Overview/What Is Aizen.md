---
title: What Is Aizen
aliases: [Aizen, Product Vision, ConversationAgent]
tags: [overview, product]
created: 2026-06-05
---

# What Is Aizen

> [!quote] One sentence
> **Aizen is a real-time copilot that listens to a live conversation and explains and
> teaches everything being discussed** — transcript, concepts, jargon, assumptions,
> sourced background, and answers — across software, finance, healthcare, legal,
> science, sports, meetings, and interviews. *"AI explains the room."*

This is the project that lives in `T:\ConversationAgent` (codename **Aizen**, repo
folder **ConversationAgent**). It is two things in one repository:

1. **A product blueprint** — a full, validated technical architecture (the
   `docs/architecture/` tree). See [[The Blueprint Documents]].
2. **Working Phase-0 code** — a runnable TypeScript monorepo that implements the
   vendor-free slice of that blueprint and then grows real features on top. See
   [[System Architecture]].

---

## The wedge: explain-and-teach, not summarize

Most "AI meeting" tools give you an **after-the-fact summary**. Aizen's bet is
**live explanation**: while a sentence is still on screen, you can click it and get

- **what it means** in plain language,
- a **breakdown of the hard words** in it, and
- if it's a question, a **short answer grounded in web search and/or your own notes**,
  every web claim carrying a citation.

That on-demand flow is the [[The Intelligence Engine|intelligence engine]], surfaced
through [[F2 - Sentence Explanation and BYO Sources]] and
[[F1 - Follow-up Answers]].

---

## How it runs: one app, four escalating modes

The same wiring runs stubbed or fully real — providers are chosen by **which keys are
present** in `.env` (decision **BD-03**, the "swap a stub for the real thing" seam).
There is no separate demo build. See [[Running and Configuring]].

| Keys present | Mode | What you get |
|---|---|---|
| none | **demo** | a canned clip drives the pipeline (transcript + flow), all stubbed |
| `ANTHROPIC_API_KEY` | **demo + real AI** | the demo sentence is explained by the real model |
| `+ DEEPGRAM_API_KEY` | **live** | speak into your mic → live transcript → real explanations |
| `+ TAVILY_API_KEY` | **live + sourced** | answers carry web citations |
| `+ GOOGLE_/MICROSOFT_*` | **+ real sign-in** | OAuth accounts instead of the stub demo account |

The audio path: the browser captures the mic, **downsamples to 16 kHz PCM16**, and
streams it over a WebSocket; the server bridges it to Deepgram, runs the engine over
the one [[The Event Bus|session bus]], and pushes transcript + results back. See
[[The Browser Client]] and [[The Server]].

---

## Headline targets (from the blueprint)

| | |
|---|---|
| **Wedge** | Live *explain-and-teach*, not after-the-fact summaries |
| **Latency** | speech → first useful card p50 ≤ 3 s / p95 ≤ 5 s; deep dives ≤ 10 s (**D07**) |
| **Stack** | Azure · Event Hubs→Kafka · Postgres+pgvector→graph DB · Claude Haiku/Sonnet/Opus · WebRTC |
| **Cost** | rebuilt MVP unit cost **~$3.5/session-hr** → ~$0.47 at scale (RISK-1: never sell "unlimited") |
| **MVP** | Web+desktop, transcribe+explain+answer, consent, Free+Pro tiers — 1k MAU |
| **Scale target (D02)** | MVP 1k MAU/~200 concurrent → Year-1 100k MAU → North-star 2M MAU |
| **Top risk** | Unit economics (RISK-1) |

These numbers come straight from the [[Architecture Decisions|decisions ledger]]
(D02, D07) and the cost/latency remediation docs — see [[The Blueprint Documents]].

---

## What's real vs. what's still gated

> [!success] Implemented & tested (vendor-free or behind a key)
> The full [[The Event Bus|event-bus]] spine, [[Data Contracts|contracts]],
> [[Correction Seams|seams]], [[The LLM Gateway|gateway]], [[Audio Capture and STT|STT]]
> (stub + real Deepgram), [[The Intelligence Engine|explain/answer engine]],
> [[The Intelligence Engine|Tavily research]], the [[The Account System|account system]]
> (OAuth + SQLite/Postgres + quota), [[S0 - Source Library and Retrieval|BYO sources]],
> [[F3 - Local File Sources|local files]], and the [[F4 - Obsidian Vault Connection|Obsidian connector]].
> ~170 tests pass.

> [!warning] Still requires a human / account (the "NEEDS_USER" list)
> Live `terraform apply` to Azure (**MAN-F04-001**), negotiated provider rate cards,
> the legal consent matrix, PII eval-set construction, and the harder P3+ lanes (Zoom
> join, billing, full a11y). The architecture is *parameterized* to accept these
> answers without rework. See [[How It Was Built - ClaudeTrees]] for the 27-task ledger.

---

## Related
- [[System Architecture]] — how the pieces fit together
- [[How It Was Built - ClaudeTrees]] — the process that produced it
- [[The Blueprint Documents]] — the design docs behind the code
- [[Architecture Decisions]] — the rules every part follows
