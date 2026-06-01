# 00 · Integration — Unified Blueprint

Conductor-produced synthesis of all five lanes (ten teams). Read in order:

| # | Doc | What it answers |
|---|---|---|
| 1 | [Conflicts & Resolutions](01-conflicts-and-resolutions.md) | Every cross-lane disagreement and its binding resolution (→ D13–D16). |
| 2 | [Unified Architecture](02-unified-architecture.md) | The single reconciled system; layer ownership; control loops; contracts. |
| 3 | [MVP Architecture](03-mvp-architecture.md) | Smallest system that ships the wedge; in/out scope; exit criteria. |
| 4 | [Scaling Architecture](04-scaling-architecture.md) | MVP → Year-1 → North-star ladder; cost trajectory; DR. |
| 5 | [Phased Implementation Plan](05-phased-implementation-plan.md) | 6 phases, ~26 weeks, critical path. |
| 6 | [Staffing Plan](06-staffing-plan.md) | ~11–13 MVP → ~22–27 Year-1; org shape; hiring order. |
| 7 | [Technical Risk Assessment](07-technical-risk-assessment.md) | 12 ranked risks + mitigations; RISK-1 = unit economics. |
| 8 | [Executive Summary](08-executive-summary.md) | The one-page leadership read. |

**Validation & remediation (2026-06-01)** — adversarial pre-build review and the
design that closes its findings (read these before Phase 0):

| # | Doc | What it answers |
|---|---|---|
| 9 | [Validation Review](09-validation-review.md) | Adversarial findings: 13 HIGH / 10 MED / 5 LOW + 4 actions. |
| 10 | [Seam Contracts](10-seam-contracts.md) | Field-level D16 adapter, supersede propagation (INV-8), `kg_delta` resync. |
| 11 | [Cost Model](11-cost-model.md) | Bottom-up unit cost (~$3.5/hr MVP), GPU crossover, margin/overage fix (RISK-1). |
| 12 | [Latency Budget](12-latency-budget.md) | p50+p95 budget that sums; speculative-on-partial trigger (D17). |
| 13 | [Consent & Privacy Redesign](13-consent-and-privacy-redesign.md) | Per-speaker consent (D18), bot gating (D19), fail-closed PII gate (D20). |

**Verdict (revised):** the blueprint is a strong, build-worthy skeleton, but the
original "zero hard architectural contradictions / internally consistent" claim
(doc 01) was overstated — three load-bearing seams were *assigned, not designed*,
and two headline numbers (latency, margin) did not survive their own arithmetic.
Docs 09–13 close those gaps; the design is now build-ready. Remaining open items
are external (rate cards, sub-processor contracts, jurisdiction matrix, eval set).

Shared conventions governing every lane: see [`DECISIONS.md`](DECISIONS.md)
(D01–D20, INV-8/9) — the canonical in-tree ledger. Outstanding human actions:
`NEEDS_USER.md` (27 tasks, 10 High) in the run directory.
