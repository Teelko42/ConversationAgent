# Integration · Blueprint Validation Review

> Adversarial pre-build review of the Aizen blueprint (2026-05-31). Four
> independent skeptical reviews — latency, unit economics, data contracts,
> trust/consent — plus a conductor-level coherence pass. The goal was to find
> where the design is optimistic, hand-waved, or internally inconsistent
> **before** committing engineering to Phase 0, not to summarize it.
>
> **Verdict:** the blueprint is a strong, coherent skeleton and is good enough to
> *build from* — but it is **not** "ready to build as-is," and doc 01's
> "zero hard architectural contradictions / internally consistent" claim is
> overstated. The two headline numbers (p50 ≤ 3 s latency; ~65% MVP margin) do
> not survive their own arithmetic, and three load-bearing integration seams are
> *asserted with an owner and a prose arrow* but never actually designed.

## Meta-finding: "resolved" too often means "assigned," not "designed"

The recurring pattern across every lane: a real seam is identified, an owner is
named, a one-sentence resolution is written, and it is then counted as closed.
Three of the highest-value seams (the D16 adapter, supersede/correction
propagation, the `kg_delta` resync protocol) have **no field-level contract**
anywhere — and in two cases the *consuming* lane's own doc still lists the same
thing as an open question (F03 OQ-3, F07 OQ-9) that doc 01 declares resolved.
This is the riskiest property of the blueprint because the confident "internally
consistent" framing discourages the detailed design these seams still need; they
will resurface at integration time, which is the most expensive place to find
them.

---

## HIGH — fix before or early in Phase 0/1 (cheap now, expensive at integration)

### H-1 · The speech→first-card latency headline is not backed by its own arithmetic
The per-stage budget table (doc 02 §2) sums to **3300 ms** (500+800+700+1000+300)
— already 300 ms over the **p50 ≤ 3 s** claim — with **no line item** for the
EventBus hops (the hot path crosses Event Hubs / Kafka-compatible log at least twice:
`STT→BUS→extract` and `explain→BUS→render`), client↔edge / edge↔provider RTT, or
queueing under concurrency. Event Hubs put→get propagation alone is ~70–200 ms per
hop and is nowhere budgeted.

### H-2 · "Extract on finals" contradicts the latency computed off partials
The committed design extracts only on `is_final` (doc 02 §2 step 3; MVP §5
"extracting on finals only"), but a final is not emitted until the speaker
pauses — STT final latency is **~2.0 s (audio-end→final, MVP)** per F01 team-02
§6, vs the 800 ms *partial* the headline implicitly chains off. The real
end-of-utterance→first-card path is therefore ~4 s+, not 2.5 s. **MVP doc §4
computes "p50 ~2.5 s" using Deepgram partials (~300 ms) while §5 of the same doc
says extraction runs on finals** — a direct internal contradiction. The
"speculative prefetch on partials" escape hatch is described as a *risk
mitigation*, not a designed path, and it conflicts with the "act on finals for
stability" rule (partial→final revisions cause card churn).

### H-3 · Explanation TTFT ≤ 1000 ms assumes a warm prompt-cache hit
The 1000 ms first-token budget leans entirely on prompt caching, but: the cached
prefix includes a rolling conversation summary refreshed by a background Haiku
job every K segments → **every refresh evicts the cache → miss → full prefix is
fresh input tokens**; the first card of any session is always cold; Anthropic
cache entries have a ~5-min TTL so any lull evicts. The miss path, the gateway
hop, provider RTT, and the additive cost of D15 provider-fallback are all
unbudgeted. 1000 ms is the *best-case hit* number presented as the budget.

### H-4 · The "~65% MVP margin" is a Year-1 number wearing an MVP label
F05 (team-10 §5.3) books Pro COGS at **$7/mo for 6 session-hrs = $1.17/hr**, but
F04's stated **MVP** unit cost is **$2.00/session-hr** (team-08 §8.2). Recomputed
at the doc's own MVP rate, 6 hrs costs $12 against a $20 price = **~40% margin,
not 65%**. Worse, doc 01's own C-9 math says $2/hr only funds **~3.5 included
hrs** at 65% margin, while F05 §5.1 advertises a **1,500 min (25 hr)** "fair-use"
Pro bound — 4–7× what the margin can absorb. A 25-hr daily-driver costs ~$50 COGS
on a $20 plan with **no overage rate ever set**. The mitigation is currently
"don't say unlimited" plus an undefined number.

### H-5 · The dominant cost line (LLM, ~70–85%) has no token-volume derivation
"$0.012/min effective" (team-10) / "$3,000/mo LLM at MVP" (team-08) are
**asserted, not derived**. For a live *explain-everything* product (~3 concept
cards/min, each triggering a Sonnet explanation + context, plus on-demand Opus
deep-dives), there is no stated tokens-per-session-hour, no in/out token counts
per card, no Opus-escalation rate (RISK-8 flags Opus as "expensive per card" but
never bounds its frequency), and no prompt-cache hit-rate assumption. The single
most important number in the business case is the least supported.

### H-6 · The self-host curve ($2.00→$0.47) — the entire margin plan — has zero GPU math
RISK-1's mitigation *is* the self-host curve (doc 04 §3: "growth and margin are
the same project"), yet no GPU TCO appears anywhere: no instance count,
utilization target, throughput/RTF, $/GPU-hr, or reserved-vs-Spot mix. Self-host
has a **fixed idle-GPU floor** that *hurts* at MVP/low volume, and the
**crossover session-hour volume** where self-host beats Deepgram/Anthropic is
never identified. The margin plan is an unpriced assumption.

### H-7 · The D16 adapter is asserted, not specified — and silently drops correction fields
The F01→F02 adapter is referenced three times as "already-designed" but is never
written field-by-field; the entire spec is a parenthetical (`×1000 for time,
unwrap speaker, rename lang`) and an "S0 Ingress ~5 ms" note. Critically, it maps
~4 fields and **silently discards `rev` and `supersedes`** — the two fields that
carry correction semantics — which is what breaks H-8.

### H-8 · Supersede/correction propagation dead-ends at F02
F01 defines a supersede protocol (a new segment with `supersedes: <old seg>`).
F02 extracts on the original final, produces a `ConceptCard` + `kg_delta` citing
that segment, then **never re-extracts** when the supersede arrives (the adapter
dropped the field; team-03 §1.6 handles only `same_as` merges and topic-boundary
retraction). Result: stale cards/kg nodes whose `sources` cite superseded text —
a live **INV-1 (provenance) violation**. `ConceptCard`/`KnowledgeGraphNode` have
no `superseded`/`retracted` state for F03 to un-render. The same dead-end breaks
user transcript edits and speaker renames (F03 OQ-5, open).

### H-9 · The `kg_delta` resync protocol (C-7) is a prose arrow, not a contract
"F03 applies in order, requests resync on gap → F04 serves replay/snapshot" has
**no snapshot message schema** (`snapshot_offer` is a bare boolean with no
`kg_snapshot` contract), **no resync-request contract** (over what channel, to
whom), and **no mapping between F02's application-level `delta_seq` and the
stream's Kafka/Event Hubs offset** (replay-by-offset can't serve "give me delta_seq
410–411"). F03 OQ-3 and F07 OQ-9 both still flag this *open* — the exact thing
C-7 declares closed.

### H-10 · Consent is modeled per-session, but the law requires per-speaker
The consent state machine (team-09 §3.3) has one terminal `consented` state for
the whole session, gated once at t=0. There is no transition for a **late-joiner
/ new speaker mid-session**, and revocation kills the whole session rather than a
speaker. In all-party-consent states (CA/FL/IL/PA/WA), the moment an unconsented
party joins, the session is a per-speaker wiretap violation with no re-gate.
Diarization produces session-local speaker IDs but nothing wires "new speaker
detected → consent re-check." The UX team already assumes per-participant consent
(team-06 roster chips) but the backend contract for it is **open** (OQ-4,
OQ-SEC-5). This single modeling error (consent as a session scalar set once, vs a
per-speaker continuously-true predicate) is the root of H-10/H-11 and the
revocation gap.

### H-11 · Meeting-bot consent for non-account participants is deferred, not solved
A Zoom bot records participants who never installed the app and never see a
consent UI; the only mechanism is an **audible disclosure**, which in all-party
states is generally **not** affirmative consent. The host "enabling the session"
is one party consenting on behalf of others — exactly what all-party law forbids.
This is the **highest** wiretap exposure and its mechanism is explicitly open
(OQ-SEC-5/3), yet the bot is in MVP scope — a launch-blocking contradiction.

### H-12 · "no_audio_retention" governs only Aizen's stores; sending audio to a 3rd-party STT is itself a disclosure
"Never written to Blob Storage" is true but legally non-load-bearing: transmitting audio to
hosted Deepgram-class STT *is* the regulated disclosure/interception event for
wiretap/HIPAA purposes, and the vendor may buffer/train unless zero-retention is
contractually enforced (OQ-SEC-1, unconfirmed). The UI "audio not stored" badge
is then **misleading** — true for Aizen, potentially false for the sub-processor.

### H-13 · The INV-6 PII gate has no defined classifier and no fail-closed default
The "no external retrieval if sensitive/PII" gate keys on `consent_class`, which
team-05 **assumes arrives already set** (A01). `pii_present` is referenced in doc
02 §4 but **appears nowhere in F02's actual pipeline** — there is no PII detector,
no accuracy/recall target, no eval set. The gate's default direction is
unspecified; given the field is assumed-set, the natural code path is
**fail-open** (missing/unknown → treated as non-sensitive → web search allowed) —
the most dangerous default for a product that listens to medical/legal/financial
conversations (RISK-11 realized).

---

## MEDIUM

- **M-1 · "One ordered stream" is really N interleaved per-class `seq` counters.**
  The gateway assigns `AudioFrame.seq`, STT assigns `TranscriptSegment.seq`, F02
  assigns `ConceptCard`/`kg_delta.seq` — three independent monotonic counters. F03
  cannot use a single `seq` watermark to detect "did I miss anything"; gap
  detection differs per message class. The "single gapless session stream" framing
  is inaccurate.
- **M-2 · F02↔F03 contract drift left unresolved.** Doc 01 reconciled F01↔F02 but
  F03's authoritative assumptions still use stale names: `InsightItem.kind`/
  `assignee` and `ts_start/ts_end` vs F02 v1's `insight_type`/`owner_speaker_id`/
  `start_ms`. F03 has the same undesigned-adapter problem as H-7, unacknowledged.
- **M-3 · Clock-domain conflation risk.** C-11 merges `emitted_at`/`ts_emit` →
  `emitted_at_us` and calls it "cosmetic," but it merges a **wall-clock** field
  with media-clock ordering under one name — if anything ever sorts by
  `emitted_at_us` it silently reintroduces the NTP skew F01 explicitly forbade.
- **M-4 · "Streaming at every stage" is false on the card path.** extract→explain
  is a hard serial dependency (explanation needs the skeleton card), so those two
  budgets genuinely add (1700 ms together). The principle holds for the transcript
  ribbon, not the concept-card path the headline measures.
- **M-5 · EventBus identity unresolved.** The integration diagram says
  "Event Hubs→Kafka-compatible log (D13)"; F01 team-01 cites "Kafka-compatible log (Kafka) per D08." Different tech,
  different latency, different decision pointer — must be pinned before H-1 can be
  validated.
- **M-6 · LLM-path degraded mode hand-waved.** The hot path is already Sonnet;
  there is no articulated graceful degradation for Sonnet TTFT under load beyond
  "warm pools + cache harder + fallback" (fallback is additive latency).
- **M-7 · Free-tier drag under-modeled; land-grab cash never sized.** 94–96% of
  Free users are pure loss with unquantified virality offset; "explicitly funded
  land-grab" has no dollar figure, runway, or burn-to-crossover, against a ~49×
  infra cost ramp ($8k→$390k/mo).
- **M-8 · TAM/SAM/SOM carry false precision.** Self-flagged as unsourced estimates
  (MAN-F05-001) yet presented as "~$13–21M ARR SOM"; ARPU blend appears to ignore
  the Free majority.
- **M-9 · DSAR erasure likely misses the cross-session evidence cache.** The
  web/evidence cache is keyed by `canonical_name` (concept), not tenant/subject,
  so the tenant-scoped delete cascade may not reach subject-derived data there —
  compounds H-13 (PII leaked via false-negative won't be erasable).
- **M-10 · Compliance-claims hygiene.** BAA/DPA/SCC and SOC2/HIPAA appear in the
  same present-tense voice as engineered controls but are manual/contractual
  prerequisites or future certifications. Needs a "claims register" separating
  (a) engineered+testable, (b) contractual prerequisite, (c) future cert-with-date.

---

## LOW (defensible / latent)

- **L-1 · Deep-dive ≤ 10 s** is tight (≤9 s retrieval + Opus over a 6-doc bundle +
  per-claim NLI in ~1 s) but **timeout-protected** ("return enriched + deep
  pending") — optimistic-but-safe, not a gap.
- **L-2 · Capture+stream ≤ 500 ms** is the one budget that genuinely holds
  (p50 ~130 ms), though TURN relay consumes most of the bragged headroom.
- **L-3 · Cross-lane version pinning** unspecified (F02 never states its F01
  `schema_version` floor) — latent evolution hazard, not a current contradiction.
- **L-4 · Revocation semantics** ("immediate" §6 vs "flagged per policy" §3.2) and
  client-cache purge of already-delivered artifacts are under-specified;
  prior third-party disclosure is irreversible and should be stated in consent text.
- **L-5 · Voiceprint/BIPA (C-4)** is genuinely sound — off by default, session-local,
  opt-in + extra consent. No finding.

---

## Recommended next actions (harden, don't redesign)

None of the High findings require changing the architecture's bones — they
require **writing the design that doc 01 assumed was already written**, plus two
quantitative models. They slot into the existing phase plan:

1. **Convert the "zero contradictions" claim into a seam-design backlog (Phase 0
   design task).** Write actual field-level contracts for the three undesigned
   seams: the **D16 adapter** (every field F02 consumes + `rev`/`supersedes`
   passthrough + a contract test), **supersede/correction propagation**
   (re-extraction trigger + `superseded`/`retracted` states on ConceptCard/KG
   node), and the **`kg_delta` resync protocol** (`kg_snapshot` schema +
   resync-request message + `delta_seq`↔offset mapping). Reconcile the F02↔F03
   field names (M-2) and pin the EventBus identity (M-5) while here.

2. **Rebuild the latency budget table (gates the wedge metric itself).** One table
   with p50 **and** p95 columns per stage that actually sum to 3000/5000 ms,
   explicit lines for bus hops ×2, provider RTT, prompt-cache miss, and
   queueing — and a binding decision on **partial-vs-final extraction** as the
   committed hot path. This determines whether p50 ≤ 3 s is achievable at all.

3. **Build a real cost model (RISK-1 is the #1 risk and currently doesn't
   reconcile).** Token-per-session-hour derivation (cards/min × in/out tokens ×
   tier blend × cache-hit %, with a capped Opus-escalation rate); a GPU TCO model
   with an explicit self-host **crossover volume**; one reconciled $/session-hr
   applied consistently to MVP and Year-1; an honest MVP margin; and a sized
   land-grab cash figure (burn to Year-1 scale). Treat the cost dashboard as a P0
   feature, as the risk doc already says.

4. **Re-model consent as per-speaker before any all-party-state or meeting-bot
   capture (legal landmine, cheap to design now).** Consent as a per-speaker set
   with `new_speaker_detected → re-gate`; wire diarization → consent re-check;
   make the **INV-6 PII gate fail-closed** with a named classifier + recall target;
   fix the "audio not stored" badge to name sub-processors; close
   OQ-SEC-1/3/5 + OQ-4 with legal sign-off. Until then, default regulated/C4
   tenants to self-host STT and gate the Zoom bot out of all-party jurisdictions.

**Bottom line:** the blueprint is build-worthy and the lane designs are
genuinely strong; the gap is that doc 01 declared internal consistency the
detailed seam-, latency-, cost-, and consent-design has not yet earned. Doing the
four items above in early Phase 0 is the highest-leverage de-risking available —
and all four are design/modeling work, not external-dependency work, so they can
start immediately without any vendor account.
