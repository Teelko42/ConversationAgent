# Team 10 — Product Strategy (Aizen)

> Lane **F05**. Owns the business around the platform that lanes F01–F04 design.
> Working name **Aizen** — "AI explains the room." This document defines who buys
> it, why, how it makes money, what ships first, and the next 12 months.
>
> This is a **product/business strategy**, not a technical design. It references
> the capabilities designed in F01–F04 **by name only** and never redesigns them.
> All scale and cost math is anchored to **D02** (1k MAU MVP → 100k MAU Year-1 →
> 2M MAU north-star) and the cost drivers F04 prices (STT minutes, LLM tokens).

---

## 0. Capability map (what we are selling — referenced by name from F01–F04)

We monetize *capabilities*, not architecture. The packaging and roadmap below
gate access to these named capabilities from the other lanes:

| Capability (named) | Lane / Team | What the user experiences |
|---|---|---|
| Live capture + system-audio + meeting-platform join | F01 / Team 1 | Speak or join Zoom/Teams/Meet; audio is captured. |
| Real-time speaker-attributed transcript (`TranscriptSegment`) | F01 / Team 2 | Accurate, diarized, confidence-scored live transcript. |
| Concept/entity/acronym extraction (`ConceptCard`) | F02 / Team 3 | Jargon, acronyms, named entities surfaced live. |
| Explain-and-teach engine | F02 / Team 4 | Plain-language explanations, examples, analogies, definitions. |
| Research, RAG, web search, citations, fact-check | F02 / Team 5 | Sourced background; "why is this true" with citations. |
| Knowledge graph (`KnowledgeGraphNode/Edge`) | F02 / Team 3 | Navigable map of the conversation's concepts. |
| Insights: action items, decisions, open questions (`InsightItem`) | F02 / Team 3 | Post-call action list, decisions log, follow-ups. |
| UX surfaces: live transcript, concept cards, topic explorer, timeline, graph viz | F03 / Team 6 | The product the user touches on web/desktop/mobile. |
| Agent orchestration, routing, memory, failure recovery | F03 / Team 7 | The reliable real-time "brain" behind the surfaces. |
| Platform: scale, DR, observability, multi-tenant | F04 / Team 8 | Reliability + the basis of our cost model. |
| Security, consent, retention, encryption, GDPR/CCPA/HIPAA roadmap | F04 / Team 9 | The basis of our Enterprise/regulated-vertical packaging. |

**The wedge / differentiation in one line:** every competitor *records and
summarizes the meeting after the fact*. Aizen **explains and teaches the
conversation while it is happening** — turning a passive transcript into a live
tutor. That is the F02 explain-and-teach engine + F01 real-time transcript, and
it is the thing nobody else does as a primary motion.

---

## 1. Product/GTM Architecture (segmentation · packaging · funnel)

> Per D12, the "Architecture" section is adapted to **product/go-to-market
> architecture**: how we segment the market, package the capabilities into
> tiers, and move users through the funnel.

### 1.1 Segmentation architecture (two motions, one product)

```
                         AIZEN
                           |
        +------------------+------------------+
        |                                     |
   PLG / INDIVIDUAL                     ENTERPRISE / B2B
   (self-serve, card)                  (sales-assisted, contract)
        |                                     |
  Free -> Pro (individual)            Team -> Enterprise
        |                                     |
  bottom-up land:                     top-down + bottom-up:
  one knowledge worker                champion in a team -> IT/Sec/Legal ->
  installs, gets value                org-wide rollout (regulated verticals)
        |                                     |
        +------------------ same core engine -+
                 (F01 capture, F02 explain/teach, F03 UX)
```

- **PLG motion** lands a single knowledge worker (the persona below), proves
  value in the first session ("aha = a concept I didn't understand got explained
  live"), then converts to **Pro** and expands seat-by-seat into **Team**.
- **Enterprise motion** is triggered when a Team account hits security/compliance
  needs (SSO, audit, retention policy, HIPAA/data-residency) — handed to sales,
  closed on contract. Gated by F04/Team 9 controls.

### 1.2 Packaging architecture (capability gating)

| Tier | Gated by | Core gate logic |
|---|---|---|
| **Free** | Usage caps | Limited live minutes/month; lite explanations (Haiku-class only); no team features; 7-day retention. |
| **Pro** | Per-seat $ | Unlimited-ish minutes (fair-use); full explain-and-teach (Sonnet hot path + Opus deep); integrations; long retention. |
| **Team** | Per-seat $ + collaboration | Pro + shared workspaces, shared knowledge graph, admin, SSO-lite, usage analytics. |
| **Enterprise** | Contract + controls | Team + SSO/SCIM, audit trails, configurable retention, no-audio-retention mode, HIPAA/BAA, data residency, self-host option, dedicated SLAs. |

### 1.3 Funnel architecture (acquisition → activation → revenue → expansion)

```
ACQUIRE         ACTIVATE              REVENUE           EXPAND          RETAIN
content/SEO  -> first session     -> Free->Pro       -> Pro->Team    -> habit:
PLG virality    "explained live"     paywall on          seat growth     used in
meeting-bot     within 60s of         minutes /          + Team->Ent      every
join virality   joining a call        deep-explain        upsell on        meeting
("Aizen joined                         + retention         compliance
your meeting")
```

- **Built-in virality:** when the Aizen bot joins a Zoom/Teams/Meet call (F01),
  every other participant sees it — a zero-CAC acquisition loop (the Otter/
  Fireflies/Read.ai playbook, which we copy deliberately).
- **Activation metric:** % of new users who get ≥1 useful live explanation in
  their first session. Target ≥ 60%.
- **Primary conversion lever:** monthly live-minute cap + gating deep
  (Opus-class) explanations behind Pro.

---

## 2. Target users — personas & segments

### 2.1 Personas

| Persona | Who | Job-to-be-done | Why Aizen (vs. notes tools) | Willingness to pay |
|---|---|---|---|---|
| **The Consultant** ("Maya") | Strategy/mgmt/IT consultant in back-to-back client calls across unfamiliar domains | "Sound expert in a domain I just got staffed on; capture decisions/actions" | Live jargon/acronym explain so she's never lost; auto action items + decisions | High (billable; tool pays for itself) |
| **The Seller** ("Devon") | AE / sales engineer in technical discovery calls | "Understand the prospect's stack live; never miss a buying signal or action" | Real-time explanation of buyer's tech terms; insights + follow-ups | High (revenue-linked) |
| **The Learner/Student** ("Sam") | University / bootcamp / self-learner in lectures | "Understand a dense lecture in real time; build a study artifact" | Live explain-and-teach + knowledge graph as a study map | Low individually; price-sensitive (Free→cheap Pro / edu) |
| **The Interviewee/Interviewer** ("Priya") | Technical-interview candidate or hiring panel | "Decode jargon under pressure / evaluate fairly with shared notes" | Live concept cards (prep mode); insights for panels | Medium |
| **The Knowledge Worker** ("Alex") | PM / analyst / researcher in cross-functional meetings | "Follow meetings outside my expertise; never re-ask 'what does X mean'" | Live explanation + searchable knowledge graph of the org's talk | Medium–High |
| **The Regulated-Vertical Pro** ("Dr. Chen / Counsel Ortiz") | Clinician, lawyer, financial advisor | "Same value, but lawful: consent, retention control, no data leakage" | Explain-and-teach **plus** F04/Team 9 consent/retention/HIPAA controls | Very High (Enterprise) |

### 2.2 Segment prioritization

| Segment | TAM weight | CAC | ACV | Compliance burden | MVP focus? |
|---|---|---|---|---|---|
| Individual knowledge workers (consultants, KWs, sellers) | High | Low (PLG) | Low-Med | Low | **Yes — beachhead** |
| Students/learners | High volume, low $ | Very low | Very low | Low | Secondary (Free funnel + edu later) |
| Teams (SMB) | Medium | Medium | Medium | Medium | Year-1 |
| Regulated verticals (health/legal/finance) | Medium $, very high ACV | High (sales) | High | **High** | Year-1+ (after F04/Team 9 compliance roadmap matures) |

**Beachhead:** individual high-context professionals (consultants, sales
engineers, cross-functional KWs) in English-first US market — they have money,
acute pain (being lost in unfamiliar-domain calls), and low compliance friction.
This matches the IDEA's "US launch first, English-first" assumption.

---

## 3. Market analysis (TAM / SAM / SOM, trends, timing)

### 3.1 Sizing (with rationale)

| Layer | Definition | Estimate | Rationale |
|---|---|---|---|
| **TAM** | All knowledge workers globally who attend meetings / could use a real-time conversation copilot | ~$30–40B/yr | ~1B knowledge workers globally (ILO/industry estimates); even at a conservative $30–40 average annual software spend on a meeting/AI-assistant tool → tens of $B. Overlaps the AI-meeting-assistant + transcription + corporate-learning markets. |
| **SAM** | English-speaking, online-meeting-heavy professionals in markets we can serve (US/UK/CA/AU/EU) with self-serve + enterprise | ~$6–9B/yr | ~120–150M such workers; ~$50–60 ARPU blend across Free→Enterprise. Constrained by language (English-first), platform reach (Zoom/Teams/Meet), and our compliance footprint. |
| **SOM (Year 1–2)** | Realistically capturable with PLG + early enterprise given D02 scale | ~$15–35M ARR ceiling at 100k MAU | At D02 Year-1 100k MAU, a 5–8% paid conversion at ~$22 blended monthly ARPU → ~$13–21M ARR; plus a handful of Enterprise contracts. SOM is the *capturable slice*, not what we plan to hit Year 1 (see §7 targets, which are more conservative). |

> Note: these are order-of-magnitude sizing figures for strategy, not audited
> market research. **MAN-F05-001** flags acquiring real analyst data
> (Gartner/IDC AI-meeting-assistant market, Grand View transcription market).

### 3.2 Trends (tailwinds)

- **Meetings exploded and stayed remote/hybrid** — durable demand for meeting AI.
- **Frontier LLMs are now good *and* cheap enough** for live explanation; D04
  (Claude Opus/Sonnet/Haiku tiering) makes the unit economics work that didn't
  exist 2–3 years ago.
- **Streaming STT commoditized** (Deepgram/AssemblyAI/Whisper-class) — F01 can
  hit the D07 latency budget at a known per-minute cost.
- **"AI copilot" is now an expected category**, not a novelty — buyers already
  understand and budget for it (lower market-education cost).
- **Regulation is tightening** (EU AI Act, two-party-consent enforcement) — a
  *risk* for sloppy entrants but a **moat** for us because F04/Team 9 builds
  consent/retention/HIPAA in as first-class (D10).

### 3.3 Timing — why now

| Factor | Status | Implication |
|---|---|---|
| LLM cost/quality crossover | Just crossed | Live explain-and-teach is now affordable per session (see §5 unit economics). |
| Incumbents stuck on "notes/summaries" | Yes | Open lane for "explain & teach" before incumbents pivot. |
| Native platform AI (Zoom/Teams/Meet) rising | Rising fast | **Threat clock is running** — we must own the "teach" wedge and cross-platform reach before native AI is "good enough." |
| Buyer budget for AI copilots | Exists | Shorter sales cycles than category-creation. |

**Window:** ~12–24 months before native meeting AI commoditizes summaries.
Strategy: don't compete on summaries; win on real-time *understanding/teaching*
and cross-platform neutrality, then defend with the knowledge graph + verticals.

---

## 4. Competitive landscape

> Columns per the brief: **positioning · strengths · gaps · Aizen
> differentiation**. The recurring gap: everyone does *notes & summaries*; nobody
> makes *understanding the live conversation* the primary job.

| Competitor | Positioning | Strengths | Gaps (vs. Aizen) | Aizen differentiation |
|---|---|---|---|---|
| **Otter.ai** | Real-time transcription + meeting notes | Strong live transcript, big brand, meeting-bot virality, integrations | Transcription/summary first; no real-time *explanation* of concepts; shallow domain understanding | We turn the same live transcript (F01) into live **explanations + teaching** (F02), not just text. |
| **Fireflies.ai** | Meeting-notes bot + CRM/workflow automation | Broad integrations, post-call automations, search | Post-hoc summaries; no in-call concept explanation or knowledge graph | Real-time concept cards + a navigable **knowledge graph** (F02/Team 3), live not after. |
| **Granola** | AI notepad that augments *your* notes | Beautiful UX, low-friction, no bot, fast adoption | Personal notes/summary focus; no live teaching, no cross-participant capture, light on regulated controls | Live **explain-and-teach** for any term + cross-platform capture + compliance tier (F04/Team 9). |
| **Read.ai** | Meeting analytics + summaries + coaching | Engagement/sentiment analytics, summaries, virality | Analytics & summary focus; doesn't explain unfamiliar *content* to the user in real time | We explain the **substance** (jargon, concepts, background w/ citations), not just meeting dynamics. |
| **Fathom** | Free-leaning AI meeting notetaker | Generous free tier, fast clips/summaries, loved UX | Notes/clips/summaries; no live concept teaching or research/citations | Live understanding + sourced research (F02/Team 5), and a paid wedge beyond "free notes." |
| **Native Zoom/Teams/Meet AI** (AI Companion / Copilot / Gemini) | Built-in meeting summaries & Q&A | Zero install, free/bundled, deep platform access, trust | Locked to one platform; summary/Q&A not live teaching; no cross-platform knowledge graph; generic, not domain-deep | **Cross-platform neutrality** + real-time **teaching** depth + portable knowledge graph the user owns across all their tools. |
| **General AI assistants** (ChatGPT voice, Claude, Gemini, Copilot) | General-purpose chat/voice assistants | Powerful reasoning, ubiquitous, cheap | Not wired into live multi-speaker meetings; no diarized transcript, no passive real-time concept surfacing, no consent/retention model | Purpose-built **live, multi-speaker, passive** copilot (F01 diarization + F03 ambient UX) — works *during* the call without being prompted. |

### 4.1 Positioning statement & moats

> **For** high-context professionals in conversations outside their expertise,
> **Aizen** is the real-time conversation copilot that **explains and teaches the
> room as it talks** — unlike Otter/Fireflies/Granola/native meeting AI, which
> only transcribe and summarize.

**Moats (in order of durability):**
1. **The "teach" data + eval loop** — proprietary explanation-quality eval and
   domain prompt tuning (F02/Team 4–5) compound with usage.
2. **Cross-platform neutrality** — we work across Zoom/Teams/Meet/in-person;
   native AI never will.
3. **Portable knowledge graph the user owns** (F02/F03) — switching cost.
4. **Compliance/regulated-vertical depth** (F04/Team 9) — hard for PLG-only
   entrants and slow for big platforms to match per-vertical.

---

## 5. Monetization

### 5.1 Pricing tiers (concrete)

| Tier | Price | Who | What it gates / includes |
|---|---|---|---|
| **Free** | $0 | Trial / students / virality | 300 live min/mo; transcript + lite explanations (Haiku-class only, no deep Opus); concept cards limited; 7-day retention; no team features; "Powered by Aizen" on shared notes. |
| **Pro** | **$20 / user / mo** ($16 annual) | Individual KWs, consultants, sellers | ~1,500 live min/mo (fair-use); full explain-and-teach (Sonnet hot path + Opus deep, F02); research + citations (Team 5); knowledge graph + topic explorer; integrations; 1-yr retention; desktop system-audio + meeting-bot join. |
| **Team** | **$30 / user / mo** ($25 annual, 3+ seats) | SMB teams | Everything in Pro + shared workspaces, shared knowledge graph, admin console, usage analytics, SSO-lite (Google/MS), centralized billing, higher fair-use pool. |
| **Enterprise** | **Custom** (~$45–75 / user / mo equiv., min commit) | Mid-market/enterprise, regulated verticals | Everything in Team + SSO/SCIM, audit trails, configurable + no-audio-retention modes, HIPAA/BAA, data residency (eu-central-1), self-host option, dedicated SLAs, priority support, security review support (F04/Team 9). |

Add-ons: **usage overage** ($ per 1,000 extra live minutes) and an
**Enterprise self-host/VPC** uplift.

### 5.2 Cost drivers (tied to what F04 prices)

The two variable cost drivers per session (D02 avg session = 30 min):

| Driver | Source | Order-of-magnitude cost | Notes |
|---|---|---|---|
| **STT minutes** | F01/Team 2 streaming STT (D05) | ~$0.0025–$0.0075 / min hosted → ~$0.08–$0.23 per 30-min session | Self-host (Whisper/Parakeet) drives this toward ~$0 at scale; hosted at MVP. |
| **LLM tokens** | F02 explain/teach (D04 tiering) | Hot-path Sonnet + occasional Opus deep + Haiku routing | Dominant cost; managed by tiering — cheap classification on Haiku, only escalate to Opus on demand. |
| Web search / RAG | F02/Team 5 | Per-query API + embeddings | Capped per session; cache common concepts. |
| Infra (compute/storage/stream) | F04/Team 8 | Amortized | Small vs. STT+LLM at MVP scale. |

### 5.3 Unit-economics sanity check (Pro seat)

> Illustrative, anchored to D02 + D04 tiering. Real numbers depend on F04 vendor
> pricing — **MAN-F05-002** flags confirming STT/LLM rate cards.

| Item | Assumption | Monthly cost / Pro seat |
|---|---|---|
| Avg usage | ~12 sessions/mo × 30 min = 360 min | — |
| STT | 360 min × ~$0.004/min (hosted, blended) | ~$1.44 |
| LLM (explain/teach) | Tiered: mostly Haiku/Sonnet, selective Opus; ~$0.012/min effective | ~$4.30 |
| Research/RAG/embeddings | capped + cached | ~$0.60 |
| Infra + bandwidth + storage | amortized | ~$0.70 |
| **Total COGS / Pro seat** | | **~$7.0 / mo** |
| **Pro price** | | **$20 / mo** |
| **Gross margin** | | **~65%** (≈$13 contribution/seat) |

| Tier | Price | Est. COGS | Gross margin | Lever |
|---|---|---|---|---|
| Free | $0 | ~$1.5 (capped, Haiku-only) | Negative (CAC) | Cap minutes hard; Haiku-only; virality offsets. |
| Pro | $20 | ~$7 | ~65% | Self-host STT + caching push to 75%+ at scale. |
| Team | $30 | ~$8 | ~73% | Shared cache across team improves margin. |
| Enterprise | ~$55 eq. | ~$12 + support | ~75–80% | Higher price absorbs compliance/support cost. |

**Sanity takeaways:** (1) Margins are healthy at Pro+ once STT moves toward
self-host (F01/D05) and concept explanations are cached (F02). (2) Free must have
a **hard minute cap + Haiku-only** or it burns LLM budget — this is the single
biggest unit-economics risk. (3) Target blended gross margin **70%+** by Year-1
scale, consistent with a fundable SaaS.

---

## 6. MVP definition + feature prioritization

### 6.1 MVP thesis

The MVP must prove the wedge — **real-time explain-and-teach** — for the
**individual knowledge-worker beachhead** on **web + desktop (system audio)**,
English-first, at **D02 MVP scale (1k MAU, ~200 concurrent sessions)**. Anything
that doesn't serve "user gets a useful live explanation in their first session"
is deferred.

### 6.2 MoSCoW (referencing F01–F04 capabilities by name)

| Priority | Capability | Lane | Why |
|---|---|---|---|
| **Must** | Live capture + desktop system-audio (F01/Team 1) | F01 | No product without input. |
| **Must** | Real-time speaker-attributed transcript `TranscriptSegment` (F01/Team 2) | F01 | The substrate the wedge runs on. |
| **Must** | Concept/acronym/entity extraction `ConceptCard` (F02/Team 3) | F02 | "What does X mean" — core surface. |
| **Must** | Explain-and-teach engine (F02/Team 4) | F02 | **The wedge.** Plain-language live explanations. |
| **Must** | Live transcript + concept-card UX (F03/Team 6, web + desktop) | F03 | The product the user touches. |
| **Must** | Agent orchestration hot path + failure recovery (F03/Team 7) | F03 | Reliability under the D07 latency budget. |
| **Must** | Consent capture + basic retention controls (F04/Team 9, D10) | F04 | Lawful to record at all (two-party consent). |
| **Must** | Core platform: multi-tenant, event backbone, observability at 200 concurrent (F04/Team 8) | F04 | Run it without falling over. |
| **Should** | Research + citations + fact-check (F02/Team 5) | F02 | Strong differentiator; can ship "lite" first. |
| **Should** | Insights: action items / decisions / open questions `InsightItem` (F02/Team 3) | F02 | High-value post-call artifact; table-stakes vs. competitors. |
| **Should** | Meeting-platform join bot (Zoom/Teams/Meet) (F01/Team 1) | F01 | Powers the virality loop — ship at least one platform in MVP if feasible. |
| **Could** | Knowledge graph viz (F02/Team 3 + F03/Team 6) | F02/F03 | Differentiator + switching cost; full viz can follow. |
| **Could** | Topic explorer / timeline (F03/Team 6) | F03 | Depth UX, post-MVP polish. |
| **Won't (MVP)** | Mobile apps (F03/Team 6, D11) | F03 | Defer; web+desktop covers beachhead. |
| **Won't (MVP)** | HIPAA/BAA, SSO/SCIM, self-host, data residency (F04/Team 9) | F04 | Enterprise/regulated — Year-1, after compliance roadmap matures. |
| **Won't (MVP)** | Multi-language (per IDEA non-goal) | — | English-first. |
| **Won't (MVP)** | CRM/workflow deep automations | F03 | Fast-follow vs. Fireflies later. |

### 6.3 RICE on the contested "Should/Could" items

> Reach (share of MVP users touched, 1–10) × Impact (1–3) × Confidence (0–1) ÷
> Effort (person-months, rough). Higher = do sooner. Used to sequence the
> Should/Could items, not the Musts.

| Feature | Reach | Impact | Conf. | Effort | RICE | Verdict |
|---|---|---|---|---|---|---|
| Insights (`InsightItem`) | 9 | 3 | 0.9 | 3 | **8.1** | Ship in MVP (Should → pull forward). |
| Research + citations (Team 5) | 7 | 3 | 0.7 | 4 | **3.7** | MVP "lite," full in Q2. |
| Meeting-join bot (1 platform) | 8 | 3 | 0.6 | 5 | **2.9** | MVP if feasible; else Q2 (powers virality). |
| Knowledge-graph viz | 6 | 2 | 0.7 | 5 | **1.7** | Q2 — differentiator, not activation-critical. |
| Topic explorer / timeline | 5 | 2 | 0.6 | 4 | **1.5** | Q2/Q3 polish. |
| Mobile app | 7 | 2 | 0.7 | 9 | **1.1** | Q3 — high effort, beachhead is desktop/web. |

**MVP feature set (for the conductor to reconcile against the MVP architecture):**
the **Must** rows + Insights + lite Research + (if feasible) one meeting-join
platform. This is the integration contract handed back in RESULT.md §Integration.

---

## 7. 12-month roadmap (quarterly) — consistent with D02

> MVP → Year-1 scale. Scale milestones map to D02: **MVP = 1k MAU / ~200
> concurrent**; **Year-1 end = 100k MAU / ~5k concurrent peak**. GTM motion shifts
> from PLG-only to PLG + early enterprise across the year.

| Quarter | Scale milestone (D02) | Product milestones | GTM motion | Key business milestones |
|---|---|---|---|---|
| **Q1 — MVP / Private beta** | ~1k MAU, ~200 concurrent | MVP Must-set: F01 capture+transcript, F02 extract+explain-and-teach, F03 web+desktop UX + orchestration hot path, F04 consent + multi-tenant core. Insights shipped. | Closed beta with **10–15 design partners** (consultants, sellers, KWs). Founder-led. | Activation ≥60% first-session explain; pricing validated; **5 paying design partners**. |
| **Q2 — Public launch / PLG** | scale toward ~10–20k MAU | Full Research+citations (Team 5); **meeting-join bot** (Zoom first → Teams/Meet); knowledge-graph viz (F02/F03); Free/Pro live with billing. | Public PLG launch; content/SEO; **meeting-bot virality loop** on; Product Hunt / community. | Free→Pro conversion 4–6%; first **$50k MRR**; self-serve funnel instrumented. |
| **Q3 — Teams + Mobile** | ~30–60k MAU, scaling concurrency | **Team tier** (shared workspaces, admin, SSO-lite, analytics); **mobile app** (F03/Team 6, D11); topic explorer/timeline; integrations (calendar, Slack/Notion export). | PLG + **bottom-up team expansion**; lifecycle/expansion marketing; first sales-assisted Team deals. | Net revenue retention >110%; **$200k MRR**; Team tier ≥20% of new revenue. |
| **Q4 — Enterprise + regulated** | **~100k MAU, ~5k concurrent peak (D02 Year-1)** | **Enterprise tier**: SSO/SCIM, audit, retention/no-audio modes, **HIPAA/BAA**, data residency (eu-central-1), self-host pilot — all per F04/Team 9 roadmap. | Add **inside sales**; target regulated verticals (health/legal/finance) + mid-market; design-partner case studies. | First **5+ Enterprise contracts**; **$500k–$1M ARR run-rate**; SOC2 Type I in progress; Series-A-ready metrics. |

### 7.1 GTM motion summary

- **Q1–Q2:** founder-led + PLG. Acquisition via meeting-bot virality + content
  on "understand any meeting." Zero/low CAC.
- **Q3:** PLG-led expansion into Teams; first light sales touch on Team deals.
- **Q4:** layer inside sales for Enterprise/regulated; compliance (F04/Team 9)
  unlocks the high-ACV segment.

### 7.2 North-star alignment

The 2M MAU / 50k-concurrent north-star (D02) is **beyond this 12-month window**;
the roadmap is explicitly sized to reach the **Year-1 100k MAU / 5k-concurrent**
reference point and leaves multi-language + global expansion as post-Year-1
(consistent with the IDEA expansion path).

---

## 7b. Technology recommendations (business/GTM stack — not the product's tech)

> D12 requires "Technology recommendations." For this lane that means the
> **commercial tooling stack** to run the business, not the product's engine
> (which F01–F04 own). Named, with rationale.

| Function | Recommendation | Why |
|---|---|---|
| Billing / subscriptions / usage metering | **Stripe** (Billing + metered usage) | Handles Free/Pro/Team self-serve, usage caps + overage, annual/monthly; fastest path (MAN-F05-003). |
| Product analytics / activation funnel | **PostHog** (or Amplitude) | Track first-session activation metric, funnel, Free→Pro conversion; PostHog self-hostable for privacy posture. |
| PLG growth / onboarding | In-app onboarding that forces a live explanation; **meeting-bot virality** (F01 join) as primary loop | Activation + zero-CAC acquisition (Otter/Fireflies playbook). |
| Enterprise sales / CRM | **HubSpot** (early), graduate to Salesforce at scale | Manage Team→Enterprise pipeline from Q3. |
| Pricing experimentation | Feature-flagged tiers + caps (LaunchDarkly-class or PostHog flags) | A/B the Free minute cap (OQ1) and gating without redeploys. |
| Customer support / success | Intercom/Zendesk + in-product help | Support PLG self-serve + Enterprise SLAs. |
| Compliance evidence (Q4) | **Vanta/Drata**-class for SOC2 | Speeds SOC2 (Q4); coordinate with F04/Team 9 auditor. |

These are **build-vs-buy = buy** decisions: none are differentiating, all are
commodity SaaS; spend engineering on the F01–F04 product engine instead.

---

## 8. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | **Native platform AI** (Zoom/Teams/Meet) commoditizes summaries and is "good enough" | High | High | Don't compete on summaries; own real-time **teaching** + cross-platform + portable knowledge graph; move fast in the 12–24mo window. |
| R2 | **Unit economics** blow up (LLM/STT cost > price) | Medium | High | D04 tiering (Haiku→Sonnet→Opus), hard Free caps, caching, move STT to self-host (F01/D05). |
| R3 | **Consent/legal** (two-party recording laws, EU AI Act) | Medium | High | F04/Team 9 consent-first (D10) is a moat, not just a checkbox; conservative defaults. |
| R4 | **Explanation quality/hallucination** erodes trust | Medium | High | F02/Team 5 citations + fact-check; eval loop; cite-or-stay-silent on low confidence. |
| R5 | **Activation fails** — users don't get the "aha" live | Medium | High | Obsess over first-session activation metric; onboarding that forces a live explanation. |
| R6 | **PLG → enterprise gap** — can't move upmarket | Medium | Medium | Build Team→Enterprise compliance early (Q4); seat-based land-and-expand. |
| R7 | **CAC rises** if virality underperforms | Medium | Medium | Diversify acquisition (content/SEO/integrations); don't depend solely on bot virality. |

---

## 9. Scalability (of the business model)

> Business scalability, anchored to D02 (the technical lanes own system scale).

- **Revenue scales with seats, not headcount:** PLG self-serve means revenue
  grows faster than GTM cost; sales is added only for Enterprise.
- **Margin improves with scale:** STT self-host (F01/D05) + concept-explanation
  caching (F02) push blended gross margin from ~65% (MVP) toward **75%+** by
  Year-1 100k MAU.
- **Concurrency cost is the constraint:** at D02 Year-1 5k concurrent sessions,
  variable cost (STT+LLM) dominates — pricing fair-use caps + tiering keep
  contribution margin positive per session.
- **Land-and-expand** drives net revenue retention >110% (Pro→Team→Enterprise),
  the key SaaS scaling lever for Series A.

---

## 10. Security (commercial implications only)

> F04/Team 9 owns the actual controls; here is the **commercial packaging** of
> them.

- Security/compliance is a **revenue feature**, not just cost: SSO/SCIM, audit,
  retention control, HIPAA/BAA, data residency, and **no-audio-retention mode**
  (D10) are the **gates that justify Enterprise pricing** (§5).
- **Trust marketing:** consent-first design (D10) and SOC2 (roadmap, Q4) become
  GTM assets for regulated buyers where competitors are weak.
- We never sell a compliance claim we can't back — SOC2/HIPAA are roadmap items
  (Q4+), not MVP claims (see **MAN-F05-005** / aligns with F04 auditor task).

---

## 11. Cost (GTM / business cost model)

> COGS unit economics are in §5; this is the **GTM/operating** cost view.

| Cost line | MVP (Q1) | Year-1 (Q4) | Note |
|---|---|---|---|
| COGS (STT+LLM+infra) | low ($ per active seat, §5) | ~25–30% of revenue | Improves with self-host/caching. |
| S&M (PLG-led) | very low (content + founder) | grows for Enterprise sales | Virality keeps CAC low early. |
| R&D | majority of burn | majority | Building F01–F04 capabilities. |
| G&A + compliance | low | rises (SOC2/HIPAA, DPA, legal) | Tied to F04/Team 9 + manual tasks. |

- **CAC target:** Free→Pro mostly organic/viral (CAC < $50); Enterprise CAC
  amortized over high ACV.
- **LTV:CAC:** target ≥ 3:1 by Year-1; Pro contribution ~$13/seat/mo × retention
  ÷ low CAC clears this if churn is controlled.

---

## 12. MVP scope (summary — the handoff to the conductor)

The MVP = **§6.2 Must rows + Insights + lite Research + (if feasible) one
meeting-join platform**, for the **individual KW beachhead**, **web + desktop**,
**English-first**, at **D02 MVP scale (1k MAU / ~200 concurrent)**, with
**consent + basic retention** lawful from day one. The wedge that must work:
**real-time explain-and-teach**. Full MVP feature set is itemized in RESULT.md
§Integration notes for reconciliation against the MVP architecture.

---

## 13. Future enhancements (post Year-1)

| Theme | Items |
|---|---|
| Reach | Mobile depth, multi-language (Spanish/EU first), in-person/ambient mode. |
| Depth | Domain packs (medical/legal/finance teaching), personalized teaching that learns the user's knowledge gaps, agentic follow-ups (draft the follow-up email/ticket). |
| Platform | Marketplace/integrations (CRM, ticketing, LMS for edu), API for embedding Aizen explanations elsewhere. |
| Moat | Org-wide knowledge graph as a searchable "second brain"; cross-meeting memory. |
| Monetization | Usage-based add-ons, edu tier, vertical SKUs (Aizen for Health/Legal/Finance), self-host/VPC. |
| Scale | Path to D02 north-star (2M MAU / 50k concurrent, global) with regional data residency. |

---

## 14. Assumptions

- A1 — Output is a strategy doc; "done" = a defensible, internally consistent plan
  (matches IDEA).
- A2 — US-first, English-first launch with later multi-language/regulated
  expansion (IDEA).
- A3 — D02 scale points are the planning anchors (1k → 100k → 2M MAU).
- A4 — STT/LLM rate cards approximate vendor public pricing; F04 confirms actuals
  (MAN-F05-002).
- A5 — Meeting-bot virality is achievable (proven by Otter/Fireflies/Read.ai).
- A6 — Frontier LLM cost stays flat-to-down, preserving margins.
- A7 — A ~15-person seed/Series-A team can ship the MVP Must-set in ~Q1 (IDEA
  audience).

## 15. Decisions (lane-local; do not contradict D01–D12)

- PD1 — **Beachhead = individual high-context knowledge workers** (consultants,
  sellers, cross-functional KWs), not students or enterprise first.
- PD2 — **Wedge = real-time explain-and-teach**; we explicitly do NOT position as
  a notes/summary tool.
- PD3 — **Four tiers: Free / Pro $20 / Team $30 / Enterprise custom.**
- PD4 — **PLG-first, sales-assisted Enterprise later** (Q4).
- PD5 — **MVP excludes mobile, multi-language, HIPAA/SSO/self-host** (deferred to
  Q3–Q4 / post-Year-1).
- PD6 — **Free is hard-capped (300 min, Haiku-only)** to protect unit economics.

## 16. Tradeoffs

| Tradeoff | Chose | Gave up | Why |
|---|---|---|---|
| Beachhead breadth vs. focus | Focus on individual KWs | Students/enterprise early | Money + acute pain + low compliance friction. |
| Notes-tool parity vs. wedge | Lead with explain-and-teach | Faster feature parity w/ incumbents | Differentiation > me-too. |
| Free generosity vs. margin | Hard-capped Free | Maximal virality | Protect unit economics (R2). |
| Speed to enterprise vs. PLG focus | PLG first | Early high-ACV revenue | Lower CAC, faster iteration; enterprise needs F04/Team 9 maturity. |
| Cross-platform vs. deep single-platform | Cross-platform neutrality | Deepest native integration | It's the moat vs. native AI (R1). |

## 17. Open questions

- OQ1 — Exact Free minute cap (300 vs. 200 vs. 500)? Needs activation/cost A/B.
- OQ2 — Is one meeting-join platform feasible inside Q1 MVP, or Q2? (F01 effort.)
- OQ3 — Edu pricing/tier — separate SKU or discount? (Sizing in §3 secondary.)
- OQ4 — Which regulated vertical first in Q4 — health, legal, or finance?
- OQ5 — Annual vs. monthly mix assumption for the ARR model.
- OQ6 — Build vs. buy billing (Stripe) — see MAN-F05-003.

## 18. Estimated complexity

| Dimension | Rating | Note |
|---|---|---|
| Strategy/doc complexity | **Medium** | Standard PLG+enterprise dual-motion SaaS; well-trodden patterns. |
| Execution complexity (the build) | **High** | Real-time AI pipeline (F01–F04) is hard; this lane depends on their delivery. |
| GTM complexity | **Medium-High** | Dual motion (PLG + enterprise) and regulated verticals add coordination cost. |
| Unit-economics risk | **Medium** | Manageable with tiering/caps/caching; the key thing to watch. |

---

*End of Team 10 — Product Strategy. Companion overview: `README.md` in this
directory. Manual user tasks logged in this lane's `MANUAL.md` and the run-level
`NEEDS_USER.md` (IDs MAN-F05-001…).*
