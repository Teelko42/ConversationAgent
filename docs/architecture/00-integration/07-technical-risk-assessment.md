# Integration · Technical Risk Assessment

Consolidated from all five lanes' Risk sections + the cross-lane conflicts (doc
01). Scored **Likelihood × Impact** (L/M/H). Owners reference lanes.

## Top risks (ranked)

| ID | Risk | L×I | Owner | Mitigation | Residual |
|---|---|---|---|---|---|
| **RISK-1** | **Unit economics underwater at MVP** — $2.00/session-hr vs $20 Pro (C-9). Heavy users burn the margin; "unlimited" framing would be fatal. | H×H | F04+F05 | Bounded Pro hours + usage overage; Free Haiku-capped; margin target deferred to Year-1 scale (self-host STT/LLM lever); cost dashboards + gateway cost-ceilings from day 1. | M — depends on hitting Year-1 scale; explicitly funded land-grab. |
| **RISK-2** | **Real-time latency budget (D07) slips** under load — multi-stage streaming pipeline, p95 ≤ 5 s is aggressive. | M×H | F01+F02+F03 | Streaming at every stage; speculative prefetch on partials; prompt caching; extract on finals only; per-stage budgets instrumented; degraded modes. | M — needs continuous load testing. |
<!-- ⚠ Updated 2026-06-01: validation (doc 09) found the D07 table doesn't sum and "extract on finals only" fails the wedge metric measured from the spoken word. Mitigation is now D17 (speculative-on-stabilized-partial, reconciled on final), layered prompt-cache breakpoints, and the degraded-mode ladder — rebuilt budget in 00-integration/12-latency-budget.md. -->

| **RISK-3** | **Hallucinated explanations** erode trust (teaching wrong things confidently). | M×H | F02 | 8-layer grounding stack; per-claim NLI verification; trust tiers T1–T4; visibly mark unverified/contested; redact refuted (INV-1/2). | L–M. |
| **RISK-4** | **STT/LLM vendor concentration** — pricing, rate limits, outages, ToS changes. | M×H | F04 | LLM gateway provider abstraction + fallback (D15); planned self-host (Whisper/Parakeet, open-weight); multi-vendor STT. | L–M. |
| **RISK-5** | **Consent / wiretapping law exposure** — two-party-consent states, recording without consent. | M×H | F04·T9 | Consent control loop (C-8); per-session consent capture (F03) → gate (F04) → stamped on every message (F01); `no_audio_retention` default; legal sign-off (MAN, High). | M — jurisdiction-dependent; never claim compliance pre-cert. |
| **RISK-6** | **Diarization accuracy** in overlapping/multi-speaker live audio. | M×M | F01·T2 | Two-regime diarization (per-track + single-channel online + offline refine); `is_overlap` flag; confidence banding. | M. |
| **RISK-7** | **Contract drift** between lanes as they evolve independently. | M×M | All | Versioned contracts in a schema registry; additive-minor / breaking-major policy; dual-emit window; D16 adapter isolates F01→F02 blast radius. | L. |
| **RISK-8** | **Cost/quality of the deep-dive (Opus + RAG)** at scale — expensive per card. | M×M | F02+F04 | Deep dive is best-effort, on-demand (user expands), cached, salience-gated; cheaper tiers for routine cards. | L–M. |
| **RISK-9** | **Knowledge-graph blow-up** for long sessions → latency + storage. | L×M | F02 | Salience pruning; recency-decayed edge weights; `kg_delta` not snapshots; per-tenant graph partition at scale. | L. |
| **RISK-10** | **Privacy/biometric (BIPA)** if voiceprints/cross-session identity enabled. | L×H | F04·T9 | Voiceprints off by default; session-local speaker IDs (C-4); explicit consent + review before any tenant-global identity. | L. |
| **RISK-11** | **PII leakage to external retrieval** (sending sensitive transcript to web search). | L×H | F02·T5 | INV-6 hard gate: `consent_class=sensitive` or `pii_present` ⇒ no external retrieval. | L. |
| **RISK-12** | **Scope creep delays the wedge** — 10 teams' worth of surface area. | M×M | F05+lead | MVP scope frozen (doc 03); everything else gated to scaling ladder/roadmap. | M. |

## Risk themes

- **Economics is the #1 technical-business risk** (RISK-1) — the architecture's
  self-host levers (doc 04 §3) are not optional nice-to-haves; they are the
  margin plan. Treat the cost dashboard as a P0 feature.
- **Trust is the product** — RISK-3/5/10/11 all attack user trust. The grounding
  stack and the consent loop are differentiators, not overhead.
- **Vendor + latency** (RISK-2/4) are managed by the same two abstractions: the
  **EventBus** (D13) and the **LLM gateway** (D15). Invest in both early.

## Open questions still to resolve (from lanes)

- DC-1 phoneme timing for captions (F01+F03) — post-MVP.
- DC-3 n-best lattice to F02 (C-3) — post-MVP accuracy work.
- Explanation depth parameter ownership + coreference ownership (F02/F03) —
  resolve in Phase 2; designs tolerate either.
- Exact STT/LLM rate cards (MAN, High) — blocks final pricing validation (RISK-1).
