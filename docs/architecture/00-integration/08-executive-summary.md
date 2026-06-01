# Aizen — Executive Summary

**Aizen is a real-time conversation intelligence platform that doesn't just
transcribe a conversation — it explains and teaches it as it happens.** Two
people discuss ARR, a clinical trial, a legal indemnity clause, or a system
design, and Aizen surfaces speaker-labeled transcript, plain-language
explanations of every concept and acronym, the assumptions and hidden context
behind what's said, sourced background, action items and decisions, and a live
knowledge graph — all within a few seconds, on web, desktop, and (later) mobile.

## The wedge

Today's tools (Otter, Fireflies, Granola, Read.ai, Fathom, native meeting AI)
**summarize after the meeting**. Aizen's differentiator is **live explain-and-
teach**: understanding delivered in the moment, grounded in citations. The
beachhead is individual high-context knowledge workers — consultants, sellers,
cross-functional operators, interviewees, and learners — US/English-first, sold
PLG via a meeting-bot growth loop, with a sales-assisted Enterprise tier arriving
once compliance matures.

## How it works (one sentence per layer)

1. **Capture** (F01·T1) — mic, desktop system-audio, mobile, or a meeting bot
   produce normalized `AudioFrame`s.
2. **Transcribe** (F01·T2) — streaming STT + diarization emit speaker-attributed,
   confidence-scored `TranscriptSegment`s.
3. **Understand** (F02·T3) — extract concepts/entities/acronyms/insights and
   build a knowledge graph (`ConceptCard`, `KnowledgeGraph*`, `InsightItem`).
4. **Teach** (F02·T4) — tiered LLMs (Claude Haiku→Sonnet→Opus) explain, with an
   8-layer anti-hallucination grounding stack.
5. **Evidence** (F02·T5) — RAG + web/internal search + per-claim verification +
   citations.
6. **Experience** (F03·T6) — live transcript, concept cards, topic explorer,
   timeline, graph viz; WCAG 2.2 AA; web/desktop/mobile.
7. **Orchestrate** (F03·T7) — a Session-Conductor routes work across tiers and
   recovers from failure inside the latency budget.
8. **Platform** (F04·T8) — AWS, an `EventBus` spine, tiered datastores, a shared
   LLM gateway, observability, multi-region, DR.
9. **Trust** (F04·T9) — consent loop, encryption, retention controls, GDPR/CCPA/
   HIPAA roadmap, enterprise controls, audit.
10. **Business** (F05·T10) — Free/Pro/Team/Enterprise, PLG-first, 12-month plan.

Everything rides one **per-session ordered event stream**; every component is a
producer/consumer on it, glued by five versioned data contracts.

## Performance & cost

- **Latency:** speech → first useful card in **p50 ≤ 3 s, p95 ≤ 5 s**; deep dives
  stream over ≤ 10 s. Achieved with streaming at every stage + prompt caching.
- **Cost:** ~**$2.00**/session-hour at MVP → **$0.98** (Year-1) → **$0.47**
  (North-star) as STT and cheap LLM tiers move self-host. This curve is the
  margin plan — growth and gross margin (target 75%+) are the same project.

## What we build first (MVP)

Web + desktop, one meeting-join path (Zoom), hosted streaming STT, extraction +
explain-and-teach + lite RAG, insights, consent + `no_audio_retention` +
encryption, single region, Free + Pro on Stripe. Deferred to the scaling ladder:
mobile, graph visualization, Teams/Meet, multi-language, SSO, HIPAA, self-host
fleets. **MVP target: 1,000 MAU / ~200 concurrent sessions.**

## Timeline & team

~**18 weeks to public beta**, ~26 weeks to GA (6 phases, doc 05), built by a lean
**~11–13-person** founding team growing to **~22–27** at Year-1 scale (doc 06).
Phases gate on outcomes (accurate transcript → working wedge → chargeable +
lawful → validated beta → scale), not calendar.

## The three things that decide success

1. **Unit economics (RISK-1).** At MVP cost the margin is thin/negative by
   design; the self-host levers and bounded pricing must convert it to 75%+ at
   scale. Never sell "unlimited." Cost dashboard is a P0 feature.
2. **Trust.** Hallucinated teaching, mis-recorded consent, or biometric overreach
   kill the product. The grounding stack and the consent control loop are core
   differentiators, not compliance overhead.
3. **Latency under load.** The aggressive D07 budget holds only with disciplined
   streaming, caching, and continuous load testing.

## Bottom line

The blueprint is internally consistent: **zero hard architectural contradictions
across all ten teams**, every technical seam resolved via documented adapters and
ownership (doc 01, D13–D16), and a clear path from a fundable MVP to a
margin-positive platform at scale. It is ready to staff and build.

---

### Open items requiring the user (top of `NEEDS_USER.md`, 10 of 27 High)

Anthropic/Claude API access + quota · STT vendor account/keys + DPA/BAA ·
web-search API · embedding/vector store · Zoom Marketplace app · AWS org +
billing owner · domain + DNS · SOC 2 auditor · privacy/legal counsel ·
recruit 10–15 design partners.
