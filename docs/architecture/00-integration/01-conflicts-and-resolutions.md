# Integration · Conflicts & Resolutions

Conductor review of all five lanes. Each row is a real cross-lane disagreement,
gap, or seam; the **Resolution** column is the binding decision (propagated into
`DECISIONS.md` D13–D16 where it changes a shared convention).

> **⚠ Refined post-validation (2026-06-01).** The adversarial review
> (`09-validation-review.md`) found that "resolved" here too often meant
> "owner assigned + prose arrow," not "designed" — three seams (D16 adapter,
> supersede propagation, `kg_delta` resync) and the consent model needed real
> field-level/state design, and two headline numbers (latency, margin) did not
> survive their own arithmetic. Those gaps are now closed in docs 10–13 and
> ratified as **D16-amendment, D17–D20, INV-8/9** in `DECISIONS.md`. The "net:
> internally consistent" claim below was overstated; read it together with doc 09.

## A. Data-contract seams

| # | Conflict | Lanes | Resolution |
|---|---|---|---|
| C-1 (IR-1) | F02 assumed `t_start`/`t_end` in **µs**, flat `speaker_id`/`speaker_label`, and `lang`; F01 authoritative emits `start_ms`/`end_ms` in **ms** (media clock), nested `speaker.{speaker_id,display_name}`, and `language` (BCP-47). | F01, F02 | **D16.** F01's contract wins (it owns `TranscriptSegment`). F02 absorbs the mismatch in its already-designed extraction-ingress adapter via an explicit field map (×1000 for time, unwrap speaker, rename lang). No redesign in either lane. |
| C-2 | `segment_id` typed as UUID by F02 but is `{session}:seg:{seq}` string in F01. | F01, F02 | Treat as **opaque string**, not UUID. F02 adapter relaxes the type. |
| C-3 | Should F02 receive the n-best STT lattice for better domain disambiguation (F01 DC-3), or only top-1 + `alt`? | F01, F02 | **MVP: top-1 + `alt` only.** Lattice exposure deferred to post-MVP accuracy work (cost/bandwidth not justified at MVP). |
| C-4 | Cross-session speaker re-identification — tenant-global stable `participant_id` vs session-local (F01 DC-2). | F01, F09(F04) | **Session-local at MVP.** Tenant-global voiceprint identity is a BIPA/biometric concern (F04 D10) — gated behind explicit consent, post-MVP, off by default. |

## B. Platform / orchestration seams

| # | Conflict | Lanes | Resolution |
|---|---|---|---|
| C-5 | Who owns the **LLM gateway** (routing, caching, fallback, cost ceilings)? F03 orchestration assumed it might own provider calls; F04 wanted a platform service. | F03, F04 | **D15.** F04 platform owns the gateway; F03/F07 orchestration consumes it and never calls providers directly. Free-tier Haiku-only + per-tier minute caps enforced here. |
| C-6 | Event-backbone concreteness — D08 left "Kafka-class" open; F02/F03 assumed durable ordered per-session stream with replay. | F04, F02, F03 | **D13.** Event Hubs (MVP) → Kafka-compatible log (Event Hubs Dedicated) (Year-1) behind an `EventBus` abstraction; replay + snapshot API provided by F04. All consumer assumptions satisfied. |
| C-7 | Stream **replay/snapshot API** for graph gap-recovery (F02 `kg_delta.snapshot_offer`, F03 resync-on-gap) — who exposes it? | F02, F03, F04 | F04 provides durable replay from the per-session log + object-store snapshots; F02 produces snapshots on demand; F03 requests resync on `delta_seq` gap. Wired in unified arch §event flow. |
| C-8 | Consent enforcement split across three lanes (F01 captures `consent.mode` on `AudioFrame`; F03 owns participant consent UX; F04 owns the consent gate + retention). | F01, F03, F04 | No conflict — complementary. Binding order: **F03 UX captures consent → F04 gate authorizes session → F01 stamps every message → F02/F03 honor `consent_class`/`pii_present` (INV-6).** Documented as the consent control loop in unified arch. |

## C. Product / cost tension

| # | Conflict | Lanes | Resolution |
|---|---|---|---|
| C-9 | **Unit economics vs pricing.** F04 cost model: ~$2.00/session-hr at MVP scale, falling to $0.98 (Year-1) and $0.47 (North-star). F05 prices Pro at $20/mo claiming ~65% MVP margin. At $2/hr, 65% margin allows only ~3.5 included hours/mo — far below a daily-driver expectation. | F04, F05 | **Flagged as top business risk (RISK-1).** Resolution path: (a) Free hard-capped at 300 min Haiku-only (already in F05); (b) Pro positioned with a **generous-but-bounded** monthly hour pool + usage-based overage, not unlimited; (c) margin target met at **Year-1 scale**, not MVP — MVP runs at thin/negative contribution by design (land-grab), explicitly funded. Marketing must not promise "unlimited." |
| C-10 | F05 MVP feature set vs MVP architecture scope — F05 pulled Insights + lite Research + one meeting-join platform into MVP; deferred mobile, graph-viz, HIPAA, SSO, multi-language. | F05, all | **Accepted.** The MVP architecture (doc 03) is scoped to exactly this set. Deferred items live in the scaling architecture (doc 04) and roadmap. |

## D. Naming / cosmetic (non-blocking, normalized at integration)

| # | Item | Resolution |
|---|---|---|
| C-11 | Envelope timestamp field named `emitted_at` (F01) vs `ts_emit` (F02). | Both are per-lane envelopes on different message types; the platform serialization layer (F04) maps both to a canonical `emitted_at_us`. Cosmetic; no code impact. |
| C-12 | ID schemes: F01 uses `{session}:seg:{seq}`; F02 uses ULIDs (`cc_`, `kgn_`, `ii_`). | Intentional and fine — different object classes. Cross-references are opaque strings. |

**Net:** zero hard architectural contradictions. One genuine business risk (C-9)
escalated to the risk assessment; all technical seams resolve via adapters and
ownership assignments already anticipated by the lanes. The blueprint is
internally consistent.

> **⚠ Corrected (2026-06-01).** This "internally consistent" net is overstated
> (see doc 09). C-1's adapter silently dropped `rev`/`supersedes` (→ D16
> amendment, doc 10); C-7's resync was a prose arrow with no schema (→ INV-8,
> doc 10); C-9's unit economics do not reconcile at the stated $2.00/hr (→ doc 11,
> realistic ~$3.5/hr MVP); and the per-session consent assumption is a per-speaker
> legal exposure (→ D18, doc 13). The seams were *assigned*, not yet *designed* —
> they are now designed in docs 10–13.
