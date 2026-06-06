---
title: Data Contracts
aliases: [Contracts, @aizen/contracts, Canonical Contracts, D06]
tags: [runtime, core, contracts]
created: 2026-06-05
---

# Data Contracts

> [!abstract] The glue
> Every lane is built separately but they fit together because they all import **one
> package of shared shapes**: `@aizen/contracts`. Each contract is a **zod schema**
> (runtime validation) with an **inferred TypeScript type**, and a script exports each
> to **JSON Schema** for non-TS consumers. This is decision **D06**: the names are fixed;
> one lane owns each schema, others reference it *by name only*.

- **Package:** `@aizen/contracts`
- **Index:** `src/index.ts` re-exports every contract + the test fixtures.
- **Export:** `scripts/export-schema.ts` → `schema/*.schema.json` (the registry).
- **Validation:** `pnpm --filter @aizen/contracts run export-schema` regenerates it.

---

## The shared envelope (`envelope.ts`)

Two envelope classes ride [[The Event Bus|the bus]]; both carry identity + ordering.

> [!important] Two clock domains that MUST NOT be conflated (D06)
> - **Media time** (`*_ms` / `*_us`, offset from session start) — authoritative for
>   ordering audio content; drift-free relative to the media.
> - **Wall-clock** (`emitted_at` / `ts_emit`, µs Unix epoch) — latency/observability
>   only; subject to NTP skew; **never** used to order media.

```ts
F01Envelope = { schema_version, tenant_id (uuid), session_id (uuid), seq,
                producer_id, emitted_at }            // AudioFrame, TranscriptSegment
F02Envelope = { schema_version, message_type, session_id, tenant_id, seq,
                ts_emit, producer, trace_id }        // ConceptCard, KG*, InsightItem, kg_delta…
```

`message_type ∈ {concept_card, kg_node, kg_edge, insight_item, kg_delta, kg_snapshot}` —
its presence is also how the bus tells F02 from F01.

---

## The five canonical contracts (D06)

### 1. `AudioFrame` (F01) — `audio-frame.ts`
A timestamped chunk of captured audio + source/consent meta. Media-clock `start_ms` /
`duration_ms`; `codec ∈ {pcm_s16le, opus, flac}`; `sample_rate_hz`, `channels`,
`samples`; `source.{kind, platform, meeting_provider, channel_role}`; and a `consent`
block (`mode ∈ {store_audio, no_audio_retention, transcript_only}`). Phase-0 carries no
real bytes — `payload`/`payload_ref` are null. Produced by [[Audio Capture and STT|Lane B]].

### 2. `TranscriptSegment` (F01) — `transcript-segment.ts`
**The integration seam between F01 and F02** (extends `F01Envelope`). The atomic unit
flowing downstream. Key fields:

| Field | Meaning |
|---|---|
| `segment_id` | opaque `{session}:seg:{seq}` — **treated as a string, never a UUID** (C-2) |
| `rev`, `is_final`, `supersedes` | **correction semantics** — must survive the adapter (INV-A1 / H-7) → [[Correction Seams]] |
| `start_ms`/`end_ms` | media clock; refined so `end_ms ≥ start_ms` |
| `text`, `language` (BCP-47), `confidence`, `confidence_band` | recognized content |
| `words[]` | per-word `{w, start_ms, end_ms, confidence, speaker_id, is_domain_term, alt}` |
| `speaker` | `{speaker_id, speaker_confidence, display_name, is_overlap, …}` → [[Audio Capture and STT|diarization]] |
| `consent` | `{mode, consent_id, pii_redacted}` passthrough (D10) |

`is_final` gates extraction; partials drive speculative extraction (**D17**).

### 3. `ConceptCard` (F02) — `concept-card.ts`
An extracted concept/entity/acronym with explanation, citations, and a graph link. Has a
lifecycle `state ∈ {skeleton, enriched, deep, error, retracted}`. The **`retracted`
state + `retraction{}` block** are the **INV-8** addition that lets the UI un-render a
card whose source was superseded — enforced by a refine:

```ts
// INV-8: a retracted card MUST carry a retraction block, and vice-versa.
if (state === 'retracted' && !retraction) ctx.addIssue(...);
if (retraction && state !== 'retracted')  ctx.addIssue(...);
```

Citations carry provenance (`type ∈ {transcript, web, internal_doc, model_parametric}`,
`transcript_segment_ids`, `trust_tier`, `support_score`) — the basis the
[[Correction Seams|supersede seam]] uses to find and retract stale cards.

### 4. `KnowledgeGraphNode` / `Edge` (F02) — `kg.ts`
The live conversation knowledge graph. Updated incrementally via `kg_delta` (monotonic
`delta_seq`, upsert/remove lists) and re-baselined via `kg_snapshot` /
`kg_resync_request` → [[Correction Seams|Seam C]].

### 5. `InsightItem` (F02) — `insight.ts`
An action item / decision / open question. Carries ≥1 transcript citation
(**INV-4**: evidence is never empty).

---

## Consent contracts (`consent.ts`) — D18/D19/D20

Consent is modeled as a **per-speaker predicate**, not a session scalar. The key value
is `ConsentContext` — the input the [[Correction Seams|D16 adapter]] reads to stamp
`consent_class`/`pii_present` **fail-closed**. Details in [[Consent and Privacy]].

```ts
ConsentClass     = 'standard' | 'sensitive'         // may this leave to external retrieval?
DisclosureScope  = 'self_host' | 'third_party_stt' | 'third_party_stt_llm'
ConsentContext   = { session_id, jurisdiction_mode, consent_class, pii_present,
                     disclosure_scope, per_speaker: Record<speaker_id, state> }
```

---

## Feature-era contracts

Added as the app grew beyond the spine (see [[F2 - Sentence Explanation and BYO Sources]],
[[The Account System]]):

| Contract | File | Purpose |
|---|---|---|
| `SentenceExplanation` | `sentence-explanation.ts` | the explain-engine output (meaning + word breakdown + grounded answer) |
| `ExplanationSource` | `sentence-explanation.ts` | a citation: `type ∈ {web, user, file, obsidian}` (web **must** carry a url, INV-1/2) |
| `FollowupAnswer` | `followup-answer.ts` | a typed follow-up's grounded answer → [[F1 - Follow-up Answers]] |
| `UserSource` | `user-source.ts` | a BYO source: `origin ∈ {paste, file, obsidian}` → [[S0 - Source Library and Retrieval]] |
| `ExtractionInput` | `extraction-input.ts` | the adapted shape Lane D consumes (post-D16) |
| `Account`, `Identity`, `Entitlement`, `SavedSession`, `StoredSource`, `StoredArtifact`, `QuotaStatus`, `QuotaError` | `account.ts` | the [[The Account System|account system]] |

---

## Why this pays off

> [!success] One source of truth
> Because every message is a contract instance, a malformed payload is caught at the
> boundary (zod), the static types make cross-lane refactors safe, and the JSON-Schema
> registry lets non-TS consumers (e.g. a future Python F02) validate the same shapes. The
> H-7 bug (a dropped field) became a *contract-test regression guard* once the contract
> was made authoritative.

---

## Related
- [[The Event Bus]] — what carries these envelopes
- [[Correction Seams]] — the adapter/supersede/resync that depend on `rev`/`supersedes`/provenance
- [[The Intelligence Engine]] — produces SentenceExplanation / ConceptCard
- [[Consent and Privacy]] — the consent contracts in action
- [[Architecture Decisions|D06]]
