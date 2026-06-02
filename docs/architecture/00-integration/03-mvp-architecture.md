# Integration · MVP Architecture

The smallest system that delivers the wedge — **real-time transcribe + explain +
teach** for individual knowledge workers — scoped to the F05 MVP feature set
(C-10) and the D02 MVP target (**1,000 MAU, ~200 concurrent sessions**).

## 1. MVP scope (in / out)

| In (MVP) | Out (deferred → doc 04 / roadmap) |
|---|---|
| Web app + desktop app (system-audio capture) | Mobile apps |
| **One** meeting-join path (Zoom bot first) | Teams / Meet / Webex joins |
| Streaming STT + online diarization (hosted) | Self-hosted STT fleet |
| Concept extraction + knowledge graph (data model) | Full graph **visualization** (data only at MVP; basic view) |
| Explain-and-teach (skeleton→enriched→deep) | Multi-language (English-first) |
| Insights (action items / decisions / open questions) | — |
| **Lite** Research/RAG (web + citations, top-1) | n-best lattice, large internal-doc KB |
| Consent capture + `no_audio_retention` + encryption | HIPAA BAA path, SSO/SCIM |
| Single region (eastus), multi-AZ | Multi-region / data residency |
| Free + Pro tiers (Stripe) | Team / Enterprise tiers |

## 2. MVP topology (deliberately boring)

```mermaid
flowchart LR
  C[Web + Desktop client] -->|WebRTC/WS| GW[API+WS Gateway<br/>Application Gateway · Container Apps]
  GW --> STT[STT worker<br/>Deepgram streaming]
  STT -->|TranscriptSegment| K[(Event Hubs<br/>per-session partition)]
  K --> EX[Extraction+Explain worker<br/>Container Apps]
  EX --> LLMGW[LLM Gateway<br/>Claude Haiku/Sonnet/Opus]
  EX -->|cards/insights/kg_delta| K
  K -->|WS fan-out| C
  EX <--> PG[(PostgreSQL Flexible Server<br/>+ pgvector)]
  EX <--> R[(Azure Cache for Redis)]
  GW <--> PG
  ALL[Blob audio/artifacts · Cosmos DB dedup/audit · Key Vault] -.-> GW & EX
```

**Key MVP simplifications (all are documented "grow-up" points):**
- **Event Hubs** (not Event Hubs Dedicated) for the event log — cheaper, managed, fine at 200
  concurrent (D13 says Event Hubs Dedicated comes at Year-1).
- **PostgreSQL Flexible Server + pgvector** does triple duty: relational, vector (embeddings), and
  **graph-as-adjacency-tables** — no managed graph DB yet (D14/D09).
- **Hosted STT (Deepgram)** — no GPU fleet to operate; pure opex.
- **Container Apps** for all compute — no AKS/cluster autoscaler, no GPU ops.
- Orchestration is the F03·T7 **Session-Conductor** running as a Container Apps task per
  active session, with stateless extraction/explanation workers behind it.

## 3. How the lanes show up at MVP

| Lane | MVP deliverable | MVP cut |
|---|---|---|
| F01 | Web+desktop capture, preprocessing, Deepgram streaming STT, online diarization, `TranscriptSegment` | Mobile, Teams/Meet, self-host STT, offline diarization refine |
| F02 | Adapter (D16), extraction → skeleton cards + insights + `kg_delta`, Sonnet explanations, lite web RAG with citations + basic NLI grounding | Large internal KB, n-best, advanced verification, deep historical context optional |
| F03 | Live transcript view, concept cards (collapsed/expanded), basic timeline, simple list-style "topics"; Session-Conductor + workers; WCAG 2.2 AA core | Graph viz canvas, topic-explorer graph, mobile UX, eval-agent sampling |
| F04 | Single-region Azure (Container Apps, Event Hubs, PostgreSQL Flexible Server+pgvector, Azure Cache for Redis, Blob, Cosmos DB), LLM gateway, consent gate, Key Vault, audit log, Azure Monitor+OTel | Multi-region, managed graph DB, Event Hubs Dedicated, SOC 2 cert (in progress), HIPAA, SSO |
| F05 | Free (300 min, Haiku-only) + Pro ($20, bounded hours + overage), Stripe, PLG meeting-bot loop | Team/Enterprise, sales motion |

## 4. MVP latency reality

The full D07 budget is met with hosted components: Deepgram partials ~300 ms,
Haiku extraction ~680 ms p95, Sonnet first token ~700 ms → **p50 ~2.5 s,
p95 ~4.5 s** speech→enriched card. Deep dives stream over ≤10 s. No part of the
MVP needs GPUs or multi-region to hit the budget.

> **⚠ Superseded by D17 / doc 12 (2026-06-01).** This "~2.5 s" is computed from
> the 300 ms *partial*, but §5 below commits to **extracting on finals only** —
> and a final is ~2.0 s after audio-end (team-02 §6). That is an internal
> contradiction (§4 vs §5). Measured from when the concept word is *spoken*,
> finals-only is ~4.6 s p50 / 9.3 s p95 — it fails the wedge metric; the committed
> fix is speculative-on-stabilized-partial (D17). It also omits the two Event Hubs
> hops + provider RTT. See `12-latency-budget.md`.

## 5. MVP cost posture (ties to RISK-1 / C-9)

At ~$2.00/session-hour (F04 MVP cost model, dominated by STT minutes + LLM
tokens), MVP runs at **thin-to-negative contribution margin by design** — this is
a funded land-grab phase. Controls already in the MVP:
- Free hard-capped at 300 min/mo, **Haiku-only** routing (LLM gateway, D15).
- Pro gets a **bounded** monthly hour pool + usage-based overage (not unlimited).
- Prompt caching + tiered routing + extracting on finals only (not partials).
  *(Superseded by **D17**: committed hot path is speculative-on-stabilized-partial,
  reconciled on final via INV-8; finals-only is the fallback. See doc 12.)*
Margin target (65%+) is a **Year-1-scale** goal (doc 04), not an MVP goal.

> **⚠ Corrected by doc 11 (2026-06-01).** The $2.00/session-hr above is understated:
> rebuilt bottom-up, MVP is **~$3.5/hr** (LLM ~$3.33/hr alone; infra dominates at
> MVP volume, not inference). At $3.5/hr the documented Pro margin is
> negative-to-thin, the advertised 25-hr fair-use cap is unfundable, and **no
> overage rate is set** — fix is a bounded hour pool + **$3/hr overage**, with the
> land-grab funded to ~$5–8M. Framing 65% as a Year-1 goal is correct; the MVP
> number was not. Full model in `11-cost-model.md`.

## 6. MVP exit criteria (what "done" looks like)

1. A user joins/records a 30-min conversation and sees accurate speaker-labeled
   transcript + ≥1 useful concept card within p95 ≤ 5 s.
2. Insights (action items/decisions/questions) extracted with ≥1 transcript
   citation each (INV-4).
3. Consent captured per session; `no_audio_retention` honored end-to-end.
4. Free→Pro upgrade flow works through Stripe; per-tier caps enforced at the gateway.
5. 10–15 design partners (MAN, High) validate the wedge and pricing.
