# Integration · Phased Implementation Plan

A build sequence from zero to Year-1 scale, derived backward from the MVP exit
criteria (doc 03 §6) and the scaling triggers (doc 04). Durations assume the
staffing in doc 06. Phases gate on outcomes, not calendar.

## Phase 0 — Foundations (Weeks 0–4)

**Goal:** the spine exists; one audio clip becomes a rendered transcript.

| Workstream | Tasks | Owner |
|---|---|---|
| Platform | AWS org/accounts/budgets (MAN-F04-001), VPC, Fargate, Kinesis, Aurora+pgvector, Redis, S3, DynamoDB, Secrets Mgr/KMS, CI/CD, OTel+CloudWatch | Platform |
| Contracts | Lock `AudioFrame`/`TranscriptSegment` (F01) + `ConceptCard`/`KG*`/`InsightItem` (F02) in a schema registry; codegen | F01+F02 |
| Edge | WebRTC/WS gateway: auth, `seq` assigner, consent gate stub | F01+Platform |
| Capture | Web + desktop (system-audio) capture → `AudioFrame` | F01 |
| LLM gateway | D15 service skeleton: route Haiku/Sonnet/Opus, prompt cache, cost accounting | Platform |

**Exit:** clip → `AudioFrame` → (stub STT) → `TranscriptSegment` → on the stream → rendered in a bare web client.

## Phase 1 — Transcription quality (Weeks 4–8)

**Goal:** real-time, accurate, speaker-labeled transcript.

- Deepgram streaming STT integration; partial→final lifecycle; revisions/supersede.
- Online diarization + confidence banding + domain biasing (tenant glossary).
- Latency instrumentation vs D07 (STT partial ≤ 800 ms).
- F02 ingress **adapter (D16)** built and tested against real `TranscriptSegment`.

**Exit:** live 2-speaker conversation transcribed at p95 partial ≤ 800 ms, WER/DER at target.

## Phase 2 — Understanding & teaching (Weeks 8–14)

**Goal:** the wedge — explain-and-teach live.

- F02·T3 extraction: skeleton `ConceptCard`s, `kg_delta`, `InsightItem`s (on finals).
- F02·T4 explanation: Sonnet enriched (first-token ≤ 1000 ms) → Opus deep (≤ 10 s); grounding/anti-hallucination stack.
- F02·T5 **lite** RAG: web search + citation model + basic NLI verification (INV-1/2/6).
- F03·T7 Session-Conductor + stateless workers + failure-recovery ladder.
- F03·T6 UI: live transcript, concept cards (skeleton→enriched→deep render), basic timeline + topic list.

**Exit:** MVP exit criteria 1–3 (doc 03 §6) met end-to-end.

## Phase 3 — Monetize & harden (Weeks 14–18)

**Goal:** chargeable, lawful, launchable.

- F05: Free (300 min, Haiku-only) + Pro (bounded hours + overage) via Stripe (MAN-F05-003); per-tier caps enforced at the gateway.
- F04·T9: consent UX (F03) ↔ consent gate (F04) ↔ `no_audio_retention` end-to-end; encryption/KMS; audit log; privacy/legal counsel sign-off (MAN, High).
- WCAG 2.2 AA core pass; accessibility-audit vendor engaged.
- SOC 2 Type II program **started** (auditor engaged, MAN-F04 High) — cert lands later.
- First meeting-join path: **Zoom bot** (Marketplace app, MAN-F01-001 High).

**Exit:** MVP exit criteria 4–5 met; public beta launchable.

## Phase 4 — Beta → GA & PLG loop (Weeks 18–26)

**Goal:** validated wedge, growth loop, retention.

- 10–15 design partners (MAN-F05-004 High) → iterate on activation + pricing.
- PLG meeting-bot virality; onboarding; usage analytics.
- Reliability hardening; cost dashboards; abuse/cap enforcement.

**Exit:** retention + activation thresholds (F05 Q1 criteria) cleared → GA.

## Phase 5 — Scale & expand (Months 7–12, → Year-1 D02)

Pull scaling triggers (doc 04) and roadmap items as demand appears:
- MSK migration; self-host STT on EKS+Karpenter GPU (cost lever, RISK-1).
- Neptune graph + knowledge-graph **visualization**; mobile apps.
- Teams/Meet joins; multi-language start.
- SOC 2 cert achieved → SSO/SCIM/RBAC + **Team/Enterprise** tiers + sales-assisted motion.
- DR to us-west-2.

## Critical path & dependencies

```
P0 spine ──> P1 STT ──> P2 understanding(wedge) ──> P3 monetize/harden ──> P4 beta ──> P5 scale
   │            │             │ (needs P0 LLM gateway + contracts)
   └ contracts ─┘             └ adapter D16 (needs P1 real TranscriptSegment)
```

Hard external gates (track in `NEEDS_USER.md`): AWS billing owner (P0), STT +
Anthropic + web-search accounts (P1–P2), Stripe + Zoom app + legal sign-off (P3),
design partners + SOC 2 auditor (P3–P4).
