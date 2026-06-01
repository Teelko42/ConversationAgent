# Integration · Unit-Cost & Margin Model (the number RISK-1 rests on)

> **Purpose.** RISK-1 (unit economics underwater) is the #1 ranked technical-
> business risk, and the validation review (doc 09, H-4/H-5/H-6) found that the
> three numbers it stands on are **asserted, not derived**: the dominant LLM cost
> line has no token-volume derivation, the "$2.00→$0.47" self-host curve has no
> GPU math, and the "~65% MVP margin" is a Year-1 cost wearing an MVP label. This
> document builds the cost from the bottom up — tokens-per-session-hour, a GPU
> TCO with an explicit self-host **crossover volume**, one reconciled
> $/session-hour applied consistently, an honest margin, and a sized land-grab
> cash figure. It closes H-4, H-5, H-6 and M-7.
>
> **Status:** Quantitative planning model. **Price inputs are public-rate-card
> estimates** (Jan-2026 knowledge); MAN-F05-002 / OQ-PLAT-1 must confirm
> negotiated Anthropic + Deepgram rates before these harden. The *method* and the
> *sensitivity conclusions* hold regardless of exact rates — that is the point.
>
> **Headline result:** rebuilt bottom-up, MVP unit cost is **~$3.5/session-hour
> (range $2.7–$4.6)**, not $2.00; the realistic Pro margin at documented usage is
> **negative-to-thin, not 65%**; and the self-host crossover that fixes it lands
> at **~Year-1 volume, not MVP** — so the land-grab is real and must be funded to
> ~$5–8M. The architecture's "growth and margin are the same project" thesis is
> directionally correct; the absolute floor is ~2× higher than documented.

---

## 0. Price inputs (planning rates — confirm via MAN-F05-002)

| Resource | Rate (planning) | Source basis |
|---|---|---|
| Claude **Haiku** (4.5-class) | $1.00 / MTok in · $5.00 / MTok out | public list |
| Claude **Sonnet** (4.x) | $3.00 / MTok in · $15.00 / MTok out | public list |
| Claude **Opus** (4.x) | $15.00 / MTok in · $75.00 / MTok out | public list |
| **Prompt cache** | read = 0.10× input · write = 1.25× input | Anthropic caching |
| **Deepgram** streaming (Nova) | $0.0043 / audio-min | growth-tier rate (pay-go $0.0077) |
| **Embeddings** | ~$0.02 / MTok | small-model embeddings |
| **Web search** API | ~$0.008 / query | Brave/Bing-class |
| **g5.xlarge** (1× A10G 24 GB) | $1.006/hr on-dem · ~$0.60 1-yr RI · ~$0.35 Spot | us-east-1 |

Spoken English ≈ **140 wpm ≈ 11,000 transcript tokens / session-hour**
(1 word ≈ 1.3 tokens). This is the workload's "fuel gauge."

---

## 1. The LLM workload model (closes H-5)

The product is **explain-everything, live**. Per the docs (§8.2, F02): ~3 concept
cards/min, Haiku extraction → Sonnet enrichment on the hot path → Opus deep dive
**on demand**. Modeled per **session-hour** with three workstreams. The two
biggest levers — **enrichment rate** and **Opus escalation rate** — are made
explicit because they are exactly what RISK-8 flagged as "expensive per card,
frequency unbounded."

### 1.1 Per-session-hour token budget (mid scenario)

| Stream | Tier | Calls/hr | Cached-in (tok) | Fresh-in (tok) | Out (tok) | Cost/hr |
|---|---|---:|---:|---:|---:|---:|
| Extraction (skeleton + kg_delta) | Haiku | 180 | 2,000 @0.1× | 100 | 150 | **$0.19** |
| Explanation (enriched, hot path) | Sonnet | 120 | 3,000 @0.1× | 400 | 400 | **$0.97** |
| Deep dive (Opus + RAG context) | Opus | 12 | — | 6,000 | 800 | **$1.80** |
| Embeddings + web search | — | — | — | — | — | **$0.37** |
| **LLM + retrieval subtotal (mid)** | | | | | | **≈ $3.33 / session-hr** |

Worked example, Sonnet line (the dominant hot-path cost):
`120 × [ (3,000 × $3/M × 0.1) + (400 × $3/M) + (400 × $15/M) ]`
`= 120 × [ $0.0009 + $0.0012 + $0.0060 ] = 120 × $0.0081 ≈ $0.97/hr`.
Output tokens at $15/MTok dominate — **this is why the explanation tier, not
extraction, is the cost center.**

### 1.2 Scenario band (the model's sensitivity is the finding)

| Lever | Low | Mid | High |
|---|---|---|---|
| Cards/min (extraction) | 2 | 3 | 4 |
| Enrichments/min (Sonnet) | 1.5 | 2 | 3 |
| Opus deep-dive escalation | 4% (≈5/hr) | 10% (≈12/hr) | 18% (≈22/hr) |
| Cache hit rate | 90% | 80% | 60% |
| **LLM + retrieval / session-hr** | **~$1.43** | **~$3.33** | **~$6.10** |

The 4× spread between Low and High is driven almost entirely by **Opus escalation
rate** and **Sonnet output volume**. Two design controls therefore have direct
P&L impact and must be enforced at the LLM gateway (D15), not left to demand:
- **Cap Opus deep-dives per session-hour** (e.g. ≤ 8/hr, queue beyond) — RISK-8's
  "expensive per card" becomes bounded.
- **Salience-gate enrichment** so not every skeleton triggers a Sonnet call.

### 1.3 Reconciliation against the documented $3,000/mo LLM (H-5)

The doc books **$3,000/mo LLM** at MVP over ~4,000 session-hrs = **$0.75/hr**.
The bottom-up mid case is **$3.33/hr — ~4.4× higher**; even the Low case ($1.43)
is ~1.9× higher. The documented figure is only reachable at the Low scenario
*and* an Opus escalation near zero *and* 90%+ cache hit — i.e. it is a
best-case, not a planning number. **The single most important number in the
business case was the least supported, and it is understated.**

---

## 2. STT cost (the one line that was well-derived)

4,000 session-hrs/mo × 60 = 240,000 audio-min × $0.0043 = **$1,032/mo ≈ $0.26/hr**
(doc says $1,200/$0.30 — consistent). STT is **not** the problem at MVP; LLM is.

---

## 3. Reconciled $/session-hour (closes the headline)

Reconstructing the doc's own MVP total ($8,000/mo ÷ 4,000 hrs) reveals the
hidden structure the "inference is 70–85% of cost" claim obscures:

| Layer | Doc-implied MVP $/hr | Bottom-up MVP $/hr (mid) |
|---|---:|---:|
| LLM + retrieval | $0.75 | **$3.33** |
| STT (hosted) | $0.30 | $0.26 |
| Infra (Fargate warm, Aurora, Redis, bus, obs, DR, edge) | $0.95 | $0.95 |
| **Total / session-hr** | **$2.00** | **≈ $4.54 (mid); $2.7 low – $4.6 high** |

Two structural findings fall out:

- **At MVP scale, infra is ~$0.95/hr — ~half the doc's own $2.00**, because warm
  Fargate pools, Aurora, observability, and DR are **fixed** costs spread over
  only 4,000 hrs. The "inference is 70–85% of cost" rule is a **scale property**
  (true at Year-1/North-star where volume amortizes fixed infra), **not an MVP
  property.** Believing it at MVP hides that low-volume economics are
  fixed-cost-dominated — a different problem than the doc frames.
- **Corrected unit-cost curve** (mid, with realistic LLM and tiering/self-host
  applied at each step):

| Scale | Doc $/hr | **Corrected $/hr (mid)** | Why it still falls |
|---|---:|---:|---|
| MVP | $2.00 | **~$3.5** | fixed infra dominates at low volume |
| Year-1 | $0.98 | **~$1.6** | tiering + cache + STT self-host + infra amortizes |
| North-star | $0.47 | **~$0.8** | open-weight cheap tiers + volume contracts |

The **shape** the architecture promised (halving-ish per scale step) survives —
"growth and margin are the same project" is directionally right. The **floor** is
~2× higher, which is what breaks the current Pro pricing.

---

## 4. Self-host GPU TCO + crossover volume (closes H-6)

The entire margin plan (doc 04 §3) is "self-host STT/LLM at scale." It had **zero
GPU math**. Here it is.

### 4.1 STT self-host (Whisper-large-v3-turbo / Parakeet on A10G)

- Turbo RTF ≈ 0.06–0.15 → with streaming chunking, **~8 concurrent real-time
  streams per A10G** (conservative).
- g5.xlarge effective $/session-hr at **full utilization**:
  - On-demand: $1.006 ÷ 8 = **$0.126/hr**
  - 1-yr RI: $0.60 ÷ 8 = **$0.075/hr**
  - Spot (batch/burst): $0.35 ÷ 8 = **$0.044/hr**
- vs **Deepgram $0.26/session-hr**.

So self-host STT is **2–6× cheaper than hosted — *only at high utilization***. The
catch H-6 named: a GPU fleet has a **fixed idle floor**. At MVP, peak 200
concurrent ÷ 8 = **25 GPUs at peak**, but average concurrency = 4,000 hrs ÷ 730 =
**~5.5 avg** → you pay for burst capacity that sits idle off-peak.

### 4.2 The crossover (when self-host STT beats Deepgram)

Self-host wins when sustained utilization keeps a minimal reserved fleet busy.
With a floor of ~4 RI GPUs ($0.60 × 730 × 4 = **$1,752/mo**, capacity ~32
concurrent ≈ up to ~23,000 session-hrs/mo) + Spot burst:

| Volume | Deepgram | Self-host (4 RI floor + Spot burst) | Winner |
|---|---:|---:|---|
| MVP (4,000 hr/mo) | $1,032 | ~$1,750 (floor underused) | **Deepgram** |
| ~10,000 hr/mo | $2,580 | ~$2,000 | **crossover ≈ here** |
| Year-1 (400,000 hr/mo) | $103,200 | ~$30–45k (high util RI+Spot) | **Self-host** (2.5–3×) |

**Crossover ≈ 8,000–12,000 session-hrs/mo** (≈ avg 11–16 concurrent sustained) —
i.e. **just past MVP, early Year-1.** This validates the doc's *timing* claim with
actual numbers, and confirms self-host STT at MVP would *raise* cost (idle floor).

### 4.3 The LLM self-host caveat the curve ignored

Self-hosting **STT** is sound. Self-hosting **LLM** is where the $0.47 North-star
floor is optimistic: open-weight models on GPU can plausibly replace the **Haiku
extraction/routing tier** (~$0.19/hr — small savings), but replacing the
**Sonnet hot explanation path** — the actual cost center ($0.97/hr) — is a
**quality bet, not just a cost lever**. If open-weight explanation quality can't
match Sonnet, the dominant cost line does **not** self-host away, and the
North-star floor is closer to **$0.8–1.0/hr than $0.47.** This is a tracked
assumption, not a fact: *the margin plan presumes open-weight ≈ Sonnet for live
teaching.* Validate with an explanation-quality eval before banking on it.

---

## 5. Margin recompute & the pricing fix (closes H-4)

### 5.1 The contradiction, quantified

F05 advertises Pro at **$20/mo** with **~1,500 min (25 hr) fair-use** (§5.1) and
books COGS at **$7/mo for 6 hr usage** (§5.3, = $1.17/hr — secretly a Year-1
cost). At the **corrected MVP $3.5/hr**:

| Usage | COGS @ $3.5/hr | On $20 price | Margin |
|---|---:|---:|---:|
| Doc's assumed 6 hr/mo | $21.00 | $20 | **−5% (loss)** |
| Light 3 hr/mo | $10.50 | $20 | 47% |
| Fair-use cap 25 hr/mo (heavy) | **$87.50** | $20 | **−337% (catastrophic)** |

Even at the **Low** unit cost ($2.7/hr): 6 hr = $16 (20% margin), 25 hr = $67
(−235%). **The 25-hr fair-use bound is 4–7× what a $20 price can absorb, and no
overage rate is set anywhere.** This is RISK-1 made concrete.

### 5.2 What $20 actually supports

| Target | COGS ceiling | Included hrs @ $3.5/hr |
|---|---:|---:|
| 65% margin (the claim) | $7.00 | **2.0 hr/mo** |
| 50% margin | $10.00 | 2.9 hr/mo |
| Break-even | $20.00 | 5.7 hr/mo |

A "daily-driver" (≈20 hr/mo) at $20 is **structurally impossible at MVP cost** —
COGS alone would be ~$70. Something must give: price, cost (self-host, which isn't
ready at MVP), or **honest caps + a real overage rate**.

### 5.3 Recommended pricing fix (corrects C-9, sets the missing overage)

1. **Pro $20 includes a bounded pool** sized to the margin, not to a vanity "25
   hr" number: **8 included hr/mo** (COGS ~$28 — still thin at MVP, healthy by
   Year-1 when $/hr → $1.6 → COGS ~$13, 35% margin). Tune as the cost curve drops.
2. **Overage = $3.00 / hr** (≈ $0.05/min) — set **above** Year-1 marginal cost
   (~$1.6) and at/above MVP marginal so heavy use stops being a loss. The current
   plan has *no* overage rate; this is the single missing number that converts a
   heavy user from a liability into contribution.
3. **Hold the line on "no unlimited"** (already a C-9 resolution) — now with the
   arithmetic that proves why.
4. **Margin honesty:** MVP Pro margin is **thin-to-negative by design** (land-
   grab); the **65% is a Year-1 target**, achieved by the cost curve + caps, and
   should be labeled as such everywhere (currently mislabeled MVP).

---

## 6. Land-grab cash, sized (closes M-7)

"Explicitly funded land-grab" appears with **no dollar figure**. A first-order
sizing (planning, salary-assumption-dependent):

| Line (monthly, MVP→Year-1 avg) | Estimate | Basis |
|---|---:|---|
| Infra + COGS at MVP | ~$14k/mo | 4,000 hr × $3.5 |
| Infra + COGS ramps toward Year-1 | → ~$640k/mo | 400k hr × $1.6 |
| Team (~15 ppl, IDEA A7), fully loaded | ~$250k/mo | dominant burn line |
| G&A + tools + compliance start | ~$30k/mo | Stripe/PostHog/SOC2 prep |

- **Revenue is negligible early:** MVP 1,000 MAU × ~6% paid × $20 ≈ **$1.2k/mo** —
  COGS alone (~$14k) is ~12× revenue. Free users (94–96%, Haiku-capped ~$1.5 COGS)
  are pure loss until virality offsets, which is **unquantified** (M-7 stands).
- **Burn to Year-1 metrics (~12–18 mo):** dominated by salaries, not infra. Rough
  cumulative: **~$5–8M** to reach the 100k-MAU / $500k–1M ARR run-rate the roadmap
  targets. **This is the land-grab number the blueprint must name** to call the
  margin-deferral "explicitly funded." Below ~$5M raised, the plan to "defer
  margin to Year-1 scale" is not funded and RISK-1 is existential, not managed.

---

## 7. What to instrument (the cost dashboard is a P0 feature — doc 07 already says so)

The model is only as good as the live signal that checks it. Day-1
instrumentation, emitted per `session_id`/`tenant_id` (ties to team-08 §8 FinOps):

| Metric | Why | Alarm |
|---|---|---|
| **tokens/session-hr by tier** (Haiku/Sonnet/Opus, in/out) | validates §1 directly | > 1.5× model |
| **Opus escalation rate** | the #1 cost-variance lever (§1.2) | > cap (8/hr) |
| **prompt-cache hit rate** | swings cost ±40% (§1.2) | < 75% |
| **$/session-hr (live)** | the reconciled §3 number, observed | > $4.6 (high band) |
| **STT GPU utilization** (when self-host) | gates the §4 crossover | < 60% (idle floor) |
| **margin/Pro-seat (rolling)** | the §5 truth | < 0% |

Gateway cost-ceiling cutoffs (D15) enforce the caps in §1.2 / §5.3 in real time.

---

## 8. Bottom line & what this does NOT close

**Closes:** H-5 (token-volume derivation + scenario band), H-6 (GPU TCO +
crossover ≈ 8–12k hr/mo + the LLM-self-host quality caveat), H-4 (margin
recompute, included-hours table, the **missing overage rate = $3/hr**), M-7 (sized
land-grab ≈ $5–8M).

**Confirms RISK-1 is real and *worse* than documented**, but **manageable**: the
cost *shape* is right, the fixes are pricing/caps/instrumentation + a funded
runway — not an architecture change.

**Does NOT close (tracked elsewhere):**
- **Negotiated rate cards** (MAN-F05-002, OQ-PLAT-1) — the inputs in §0 are list
  rates; volume/committed-use discounts move the absolute numbers (not the
  conclusions).
- **Open-weight explanation-quality eval** (§4.3) — the bet the North-star floor
  depends on; belongs with F02/Team-4 eval work.
- **Latency budget** (recommendation 2) — independent; some cost levers (cache,
  finals-only) interact with it and should be co-decided.
- **Virality/CAC offset** for the Free-tier loss (M-7 remainder) — a GTM-data
  question, not a cost-model one.

**Next concrete step:** wire the §7 metrics into the cost dashboard as the first
FinOps deliverable (team-08 §8 already calls cost-per-session a first-class SLO),
and feed the corrected §5.3 pricing + overage into F05's tier definitions.

---

*Authored as remediation item 3 of doc 09 (Blueprint Validation Review). Planning
model; price inputs pending MAN-F05-002. Method and sensitivity conclusions are
rate-independent.*
