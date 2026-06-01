# Integration · Latency Budget (rebuilt to actually sum — and to a real reference point)

> **Purpose.** The wedge metric *is* latency: "explains the conversation **while
> it is happening**." The validation review (doc 09, H-1/H-2/H-3, M-4/M-5/M-6)
> found the headline "speech → first useful card p50 ≤ 3 s" is not backed by its
> own arithmetic: the per-stage table (doc 02 §2) sums to **3300 ms > 3000 ms**,
> has **no line for the EventBus hops / provider RTT / cache-miss**, chains off
> the **800 ms partial** while the committed design **extracts on finals (~2.0 s)**,
> and never says **what "speech" means** (when the word was spoken, or when the
> utterance ended). This document rebuilds the budget with p50 **and** p95 columns
> that sum, explicit bus/RTT/cache lines, a precise reference point, and a
> **binding partial-vs-final decision**. It closes H-1, H-2, H-3, M-4, M-6 (and
> consumes M-5's bus pin).
>
> **Status:** Binding latency design. Numbers are planning estimates from the lane
> docs (team-02 §6, team-04 §1, team-08 §4/§7) + standard AWS/Anthropic network
> constants; they harden once the §8 instrumentation runs against real traffic.
>
> **Headline result:** measured from **utterance-end**, finals-only enrichment
> fits 3 s/5 s **on a cache hit** (~2.6 s/4.3 s) — but measured from **when the
> concept word was actually spoken** (what users perceive), finals-only is
> **~4.6 s p50 / 9.3 s p95 — it fails the wedge metric.** The only design that
> meets "concept-word → card ≤ 3 s p50 / 5 s p95" is **speculative extraction on
> a stabilized partial, reconciled on final** (~1.8 s/3.4 s). That reverses the
> current "extract on finals only" stance and is the central decision here. It is
> not free: it trades bounded card churn (absorbed by Seam B's supersede/retract,
> doc 10) for latency. The live transcript ribbon is genuinely fast and fine.

---

## 0. Three problems with the old headline

1. **It doesn't sum.** 500 + 800 + 700 + 1000 + 300 = **3300 ms** > the 3000 ms
   p50 claim, *before* any bus hop, provider RTT, or queueing (H-1).
2. **It chains off the wrong STT number.** The table uses the **800 ms partial**,
   but doc 02 §2 step 3 and MVP §5 commit to **extract on `is_final`** — and
   audio-end→final is **≤ 2.0 s** (team-02 §6), not 800 ms (H-2). MVP doc §4 even
   contradicts itself: it computes "p50 ~2.5 s" from 300 ms partials while §5 of
   the same doc says finals.
3. **It never defines "speech."** "Speech → card" reads as *when the concept word
   was spoken*. The arithmetic silently measures from *utterance-end*. Those
   differ by the **concept-to-end tail** — often 2–5 s — and that gap is the whole
   ballgame.

This rebuild fixes all three: precise reference points (§1), p50+p95 that sum
with every hop (§2–§4), and a committed extraction trigger (§4).

---

## 1. Precise reference points (measure from the human, not the machine)

| Ref point | Definition | Why it matters |
|---|---|---|
| `t_word` | wall-clock when the **concept word leaves the speaker's mouth** | what the user actually perceives as "live" |
| `t_uend` | wall-clock when the **utterance ends** (speaker pauses → endpoint) | what the old budget silently measured from |
| `t_tail` | `t_uend − t_word` | the concept-to-end gap; **p50 ≈ 2 s, p95 ≈ 5 s** (turns cap at the 8 s max-segment, team-02 §1.1) |

> **Clock note (M-3):** all latency here is **wall-clock**; it is never used to
> order media (that is media-clock `*_ms`). The two domains stay separate, per
> F01 data-contracts §1 and Seam-A INV-A2.

**Network/infra constants used below** (planning; team-08 §4/§6, M-5 pins the
bus = **Kinesis** at MVP):

| Constant | p50 | p95 | Note |
|---|---:|---:|---|
| Capture + edge stream (mic → STT ingest) | 110 | 280 | "capture+stream ≤500" budget; L-2 holds |
| **Bus hop** (Kinesis put → propagate → get) | 80 | 200 | **omitted in the old budget (H-1)**; ×2 on the card path |
| Internal svc hop (Fargate ↔ LLM gateway) | 5 | 20 | |
| Anthropic API network RTT (in-region) | 40 | 120 | gateway lookup + network, excl. compute |
| WS fan-out → client + render paint | 100 | 260 | inside the old "render ≤300" |

---

## 2. Live transcript ribbon (the path that genuinely streams — M-4)

This is the partial→caption path. "Streaming at every stage" is **true here** and
it is fast:

| Stage | p50 | p95 | Source |
|---|---:|---:|---|
| Capture + edge stream (mic → STT) | 110 | 280 | team-01 / D07 |
| STT partial emit (single-channel, recv→partial) | 330 | 770 | team-02 §6.1 |
| Partial → bus → WS → client | 100 | 260 | constants |
| Client caption render | 50 | 140 | |
| **Spoken word → live caption** | **~590** | **~1450** | **≤0.6 s / ≤1.5 s ✓** |

No change needed. Sub-second live captions are achievable and on-budget. The
problem is entirely on the **concept-card** path below.

---

## 3. Concept-card path — FINALS ONLY (the current committed design)

Extraction on `is_final` (doc 02 §2, MVP §5). Measured honestly from both
reference points.

### 3.1 From utterance-end (`t_uend`) — what the old table *actually* computed

| Stage | p50 | p95 | Source |
|---|---:|---:|---|
| `t_uend` → STT **final** emitted | 1400 | 2000 | team-02 §6 (target ≤2.0 s; incl. endpoint silence wait) |
| Final → **bus hop 1** → extraction worker | 80 | 200 | **new line (H-1)** |
| D16 adapter ingress (S0) | 5 | 15 | doc 10 Seam A |
| Extraction (Haiku skeleton) | 400 | 700 | D07 ≤700; team-04 |
| *(skeleton chip can render here: + deliver)* | *(100)* | *(260)* | |
| Sonnet enrich: gateway + Anthropic RTT | 40 | 120 | new line |
| Sonnet **first token** (prompt-cache **hit**) | 600 | 1000 | D07; team-04 §1.1 |
| First tokens → **bus hop 2** → WS → render | 100 | 260 | **new line (H-1)** |
| **Skeleton chip visible** | **~1985** | **~3175** | |
| **Enriched card first content** | **~2625** | **~4295** | **fits 3/5 — but only from `t_uend`, only on a cache hit** |

### 3.2 From concept-word (`t_word`) — what the user actually experiences

Add `t_tail` (p50 2000, p95 5000):

| | p50 | p95 |
|---|---:|---:|
| Enriched, from `t_word` = §3.1 + `t_tail` | **~4625** | **~9295** |

**This is the finding.** Finals-only delivers the concept card **~4.6 s p50 /
9.3 s p95 after the word was spoken** — it **fails** the ≤3 s/5 s wedge metric by
a wide margin. The headline only "passes" by quietly measuring from utterance-end
and assuming a cache hit. For a 12-word sentence where the jargon lands in word 3,
the user has spoken nine more words and moved on before the card appears.

---

## 4. The binding decision: speculative-on-stabilized-partial (recommended)

To meet "concept-word → card ≤ 3 s," extraction must trigger on a **stabilized
partial** that contains the concept — not wait for the final. This removes **both**
the `t_uend→final` wait (1.4–2.0 s) **and** the `t_tail` (2–5 s) from the
perceived path.

### 4.1 From concept-word (`t_word`), speculative

| Stage | p50 | p95 |
|---|---:|---:|
| `t_word` → partial containing it **stabilizes** (≥300 ms unchanged, team-02 R5 hysteresis) | 600 | 1100 |
| Partial → bus hop 1 → extraction | 80 | 200 |
| D16 adapter | 5 | 15 |
| Extraction (Haiku skeleton) | 400 | 700 |
| Sonnet gateway + RTT | 40 | 120 |
| Sonnet first token (cache hit) | 600 | 1000 |
| Deliver (bus hop 2 + WS + render) | 100 | 260 |
| **Concept-word → enriched (speculative)** | **~1825** | **~3395** | **≤3 s/5 s ✓** |

With a layered-cache **miss** (§5 fix bounds it to +~200 ms): **~2025 / ~3595** —
still inside 3 s/5 s. The slack survives a miss; this is why §5 matters.

### 4.2 The decision, stated plainly

> **D17 (new).** The committed hot path is **speculative extraction on a
> stabilized, high-confidence partial, reconciled on the final.** Finals-only
> extraction becomes the **fallback/degraded mode** (§7), not the default. This
> **reverses** the current "extract on finals only" stance (doc 02 §2, MVP §5),
> which cannot meet the wedge metric.

**What it costs (and how that's paid):**
- **Card churn:** a speculative card built on a partial may need correction when
  the final revises the text. This is exactly the `supersedes`/`retracted` flow
  designed in **doc 10 Seam B** — speculative extraction is *why* Seam B exists.
  Budget: churn affects the minority of cards where the final materially changes
  the concept span.
- **Bounded speculation:** only trigger on partials that (a) have been stable
  ≥300 ms (hysteresis), (b) carry a high-confidence domain term / entity
  (`confidence_band=high`, `is_domain_term`), and (c) clear the salience gate.
  This keeps wasted Haiku/Sonnet calls — and the §11-of-the-cost-model Opus
  escalation — bounded.
- **Cost interaction:** speculative enrich raises LLM call volume on the
  `enrichments/min` lever that the cost model (doc 11 §1.2) flagged as a primary
  cost driver. The salience+stability gate is the shared control point for **both**
  latency and cost — tune it once, against both budgets.

**Why not just relabel the metric to `t_uend`?** Because the product's entire
claim is *live*. A card that lands 4.6 s after the word, mid-next-sentence, is not
the wedge. Honest finals-only would force the headline to "utterance-end → card,"
which undersells on cache hits and still fails on cache miss + long tails.

---

## 5. The prompt-cache reality (closes H-3) — and the fix that makes p95 robust

The 1000 ms TTFT "leans entirely on prompt caching" (team-04 §1.3). The cached
prefix includes a **rolling conversation summary refreshed by a background Haiku
job every K segments** (team-04 §1.5). Three ways it misses:

1. **Cold start:** the first card of any session has no cache → full ~3–5k-token
   prefix is fresh input → first token slips ~+500–600 ms.
2. **Summary-refresh eviction:** every refresh changes the prefix → the *next*
   enrich call misses. Frequent K = high miss rate on the hot path.
3. **TTL eviction:** Anthropic cache entries have a ~5-min TTL → any lull evicts.

**Fix — layered cache breakpoints (do this before relying on 1000 ms):**

| Cache layer | Contents (~tokens) | Volatility | Breakpoint |
|---|---|---|---|
| **Stable prefix** | system prompt + persona + domain few-shot + style guide (~2–3k) | ~never | long-lived cache |
| **Volatile block** | rolling summary + session glossary (~1–2k) | every K segments | **separate, later** breakpoint |
| **Fresh** | card skeleton + local transcript window (~400) | per call | — |

- Putting the volatile summary in its **own breakpoint after** the stable prefix
  means a refresh invalidates **only the volatile block (~+150–300 ms reprocess)**,
  **not** the expensive stable prefix (~+500–600 ms). This is what bounds the §4.1
  miss adder to ~200 ms.
- **Keep-warm ping:** during an active session, a tiny cache-touch < every 5 min
  prevents TTL eviction.
- **Refresh cadence:** make K large enough (~every 30–60 s) that most enrich calls
  see a stable volatile block; the summarizer is async and off the hot path.
- **Budget honesty:** the §3/§4 tables use **cache-hit** first-token (600/1000);
  the **cold first card of a session** is explicitly ~+500 ms and is exempt from
  the SLO for the session's first card (tracked separately, §8).

---

## 6. Bus hops, RTT, and queueing — the lines the old budget omitted (H-1)

- **Bus = Kinesis at MVP** (M-5 / doc 10 §0). Put→propagate→get ≈ **80 ms p50 /
  200 ms p95 per hop**. The card path crosses it **twice** (final/partial →
  extractor; card → WS fan-out) = **160/400 ms** — **5–13 % of a 3000 ms budget**,
  previously unbudgeted. At Year-1 the extraction→explanation split adds a **third
  hop** (the MVP "extract+explain" worker is one process; the scaled topology
  separates them, doc 04 §2) — budget for it before that migration.
- **Provider RTT + gateway:** the D15 gateway lookup + Anthropic network RTT is
  **40/120 ms**, separate from model compute (the 600/1000 first-token). D15
  **provider fallback is additive** latency — a fallback invocation roughly
  doubles the RTT+TTFT for that call; it is an exceptional path, excluded from the
  steady-state budget and surfaced as a degraded event (§7).
- **Queueing:** at MVP 200 concurrent on provisioned warm pools, queueing is
  near-zero and folded into the p95 hop figures. The true backpressure signal is
  **consumer lag** (team-08 SLO < 1 s); when lag exceeds threshold the system
  enters degraded mode (§7) rather than silently inflating p95.

---

## 7. Degraded-mode ladder (closes M-6)

The hot path is already Sonnet; there is no cheaper *quality* tier to fall back to
for explanation prose (Haiku is too weak — team-04 §1.1). So degradation sheds
**scope and speculation**, not model quality, in order:

| Trigger | Degrade action | User-visible effect |
|---|---|---|
| Consumer lag > 1 s OR Sonnet TTFT p95 breach | **Drop speculation → finals-only** (§3) | cards a bit later, no churn |
| Lag persists | **Skeleton + `definition_short` only**, queue full enrich | instant chip + one-line gloss; rich body lags |
| LLM gateway cost-ceiling / provider error | **Provider fallback** (additive RTT) then **parametric-marked** explanation | "sources pending" note |
| Severe overload | **Salience gate tightens** (fewer cards enriched) | only the most important concepts get cards |

Each step is reversible and emitted as an observable event (not a silent SLO
inflation). The deep-dive (Opus) path is already best-effort with a hard timeout →
"return enriched + deep pending" (team-04 §3, L-1) — unchanged.

---

## 8. Revised D07 SLOs (measurable, honest — replace the ambiguous headline)

| SLO | Reference | p50 | p95 | Notes |
|---|---|---:|---:|---|
| **SLO-L1** Live caption | `t_word` → caption | ≤ 0.7 s | ≤ 1.5 s | §2; holds today |
| **SLO-L2** Skeleton chip | `t_word` → chip | ≤ 1.5 s | ≤ 3.0 s | §4, speculative |
| **SLO-L3** Enriched card | `t_word` → first explanation content | **≤ 3.0 s** | **≤ 5.0 s** | §4, speculative, cache-hit; **the wedge metric** |
| **SLO-L4** Deep dive | card-open → deep content | — | ≤ 10 s | best-effort, timeout-protected |
| *exemptions* | session's **first** card (cold cache) | +~0.5 s | +~0.5 s | tracked separately |

Every leg carries `trace_id` + `seq` (team-08 §7) so a single trace reconstructs
which stage in §2–§4 blew the budget — and so SLO-L3 is checked against `t_word`,
not `t_uend`. **Instrument these before tuning:** the §4/§5 numbers are planning
estimates; the trace data replaces them with measured p50/p95 per stage.

---

## 9. What this changes, and what it does NOT close

**Closes:** H-1 (budget sums, with bus/RTT lines and p50+p95), H-2 (the
partial-vs-final contradiction is resolved by **D17 speculative-on-partial**, and
the MVP §4↔§5 internal contradiction is named), H-3 (cache-miss reality +
layered-breakpoint fix + cold-start exemption), M-4 (streaming holds on the
ribbon, not the card path — now explicit), M-5 (bus pinned to Kinesis, hops
budgeted), M-6 (degraded-mode ladder).

**Requires (cross-doc):**
- **Doc 10 Seam B** is now load-bearing — speculative extraction *depends on* the
  supersede/retract flow to absorb churn. The two docs must ship together.
- **Doc 11 cost model** — speculative enrich raises the `enrichments/min` lever;
  the **salience+stability gate is the shared control** for latency and cost.

**Does NOT close (tracked elsewhere):**
- **Doc edits to 02 §2 / 03 §4-§5** — the source docs still print the old 3300 ms
  table and the §4↔§5 contradiction; they should be updated to reference D17 +
  these SLOs (mechanical follow-up).
- **D17 ratification** — reversing "extract on finals only" is a real decision
  spanning F01 (partial stability signal), F02 (speculative trigger + reconcile),
  F03 (render churn handling); record it in `DECISIONS.md` as **D17** with those
  owners.
- **Measured validation** — every number here is a planning estimate until §8
  instrumentation runs under load (RISK-2's "continuous load testing").

**Next concrete step:** ratify **D17** in `DECISIONS.md`, wire the SLO-L1..L4
traces (§8) as the first observability deliverable, and have F02 implement the
salience+stability gate as the shared latency/cost control point.

---

*Authored as remediation item 2 of doc 09 (Blueprint Validation Review). Binding
latency design; numbers are planning estimates pending §8 instrumentation. Depends
on doc 10 (Seam B) and interacts with doc 11 (cost model).*
