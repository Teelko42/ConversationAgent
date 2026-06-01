# Integration · Staffing Plan

Headcount mapped to the lanes and the phased plan (doc 05). Lean MVP team that
grows along the scaling ladder (doc 04).

## 1. MVP team (Phases 0–4) — ~11–13 people

| Role | Count | Lane focus | Why |
|---|---|---|---|
| Founding/Tech lead (player-coach) | 1 | All — owns the unified arch + contracts | Keeps the seams (D16, D13–D15) coherent |
| Real-time/audio engineer | 1 | F01·T1 | WebRTC, system-audio, capture, preprocessing |
| Speech/ML engineer | 1 | F01·T2 | Streaming STT, diarization, accuracy tuning |
| AI/applied-LLM engineers | 2 | F02·T3/T4/T5 | Extraction, explanation, RAG, grounding — the wedge |
| Orchestration/backend engineer | 1 | F03·T7 | Session-Conductor, workers, failure recovery |
| Full-stack / frontend engineers | 2 | F03·T6 | Web + desktop UI, live rendering, a11y |
| Platform/DevOps engineer | 1 | F04·T8 | AWS, EventBus, datastores, LLM gateway, CI/CD, observability |
| Security/compliance engineer (or fractional + counsel) | 0.5–1 | F04·T9 | Consent loop, encryption, SOC 2 program, threat model |
| Product manager | 1 | F05 | Scope, prioritization, design-partner program |
| Design (product + a11y-aware) | 1 | F03·T6 / F05 | UX, wireframes→production, WCAG |
| (Founder/CEO often covers GTM/PM early) | — | F05 | Market, pricing, fundraising |

**MVP total: ~11–13.** Matches the "first ~15-person team" audience (IDEA.md).

## 2. Year-1 scale team (Phase 5) — add ~10–14

| Add | Count | Reason (scaling trigger, doc 04) |
|---|---|---|
| GPU/ML infra engineer | 1–2 | Self-host STT + open-weight LLM on EKS+Karpenter (cost lever) |
| Data/graph engineer | 1 | Neptune migration + graph viz pipeline |
| Mobile engineers (iOS/Android) | 2 | Mobile apps |
| Integrations engineer | 1 | Teams/Meet/Webex joins |
| SRE | 1–2 | Multi-region, DR, SLOs at 5k concurrent |
| Security/compliance (full-time) | 1 | SOC 2 cert → HIPAA path, enterprise controls |
| Eng manager(s) | 1–2 | Span of control as team passes ~15 |
| GTM: sales + CS + growth/marketing | 3–4 | Enterprise motion + PLG funnel |
| Data analyst / DS | 1 | Activation, retention, unit-economics dashboards (RISK-1) |

**Year-1 total: ~22–27.**

## 3. Org shape

- **MVP:** one squad, flat, contract-owners model — each engineer owns a lane's
  doc and its product surface; the tech lead arbitrates seams.
- **Year-1:** split into **Pipeline** (F01+F02), **Experience** (F03), and
  **Platform/Trust** (F04) squads, with Product+GTM alongside. The data
  contracts (D06/D16) are the team interfaces — squads ship independently against
  versioned contracts, exactly as the ClaudeTrees lanes did.

## 4. Hiring priority order

1. AI/applied-LLM engineers (the wedge lives or dies here).
2. Platform/DevOps (the spine everything rides on).
3. Speech/ML + real-time/audio (transcription quality = trust).
4. Full-stack/frontend + design (the product users feel).
5. Security/compliance (unblocks Enterprise + regulated verticals).
6. GTM (after wedge validated by design partners).
