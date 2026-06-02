# Team 2 — Speech Recognition & Speaker Identification (Diarization)

> Lane **F01** · Aizen. This team turns the `AudioFrame` stream (Team 1) into the
> authoritative **`TranscriptSegment`** stream (data-contracts.md §3) — the
> **F01→F02 seam**. It owns streaming STT, diarization, confidence scoring,
> domain biasing, language detection, and accuracy/latency targets.
>
> Budget anchor (D07): **STT partial ≤ 800 ms** (inside the 3 s p50 / 5 s p95
> end-to-end). STT strategy anchor (D05): streaming STT hot path; evaluate hosted
> vs self-hosted with a tradeoff table; **diarization is owned here**. Scale
> (D02), cloud (D03), privacy (D10) as run-wide.

---

## 1. Architecture

```
 AudioFrame stream (16k mono, per channel_role, VAD-gated)
        │
        ▼
 ┌───────────────────────────────────────────────────────────────┐
 │                 STT ORCHESTRATOR (per session)                  │
 │                                                                 │
 │  ┌───────────┐   ┌──────────────┐   ┌────────────────────────┐ │
 │  │ Language  │   │ Streaming    │   │ Diarization             │ │
 │  │ ID (LID)  │──►│ ASR engine   │   │  • per-track (if labeled)│ │
 │  │ (first 3s)│   │ (partials +  │   │  • online clustering    │ │
 │  └───────────┘   │  word times) │   │    (single-channel)     │ │
 │        │         └──────┬───────┘   └──────────┬─────────────┘ │
 │        │                │                       │               │
 │   biasing/custom        │ partial text          │ speaker_id    │
 │   vocab injection ──────┘     + word conf        │ + confidence  │
 │        │                                          │              │
 │        ▼                ▼                          ▼              │
 │  ┌────────────────────────────────────────────────────────────┐ │
 │  │ FUSION + ENDPOINTING                                        │ │
 │  │  • align words ↔ speaker turns                              │ │
 │  │  • endpoint (VAD + model + max-duration) → is_final         │ │
 │  │  • aggregate confidence, set confidence_band                │ │
 │  │  • domain-term tagging, inverse text normalization (ITN)    │ │
 │  │  • optional LLM post-edit (async, supersede) [Haiku-class]  │ │
 │  └────────────────────────┬───────────────────────────────────┘ │
 └───────────────────────────┼─────────────────────────────────────┘
                             ▼
              TranscriptSegment (partial rev0..n → final)
                             │  per-session ordered log (D08)
                             ▼          → F02 / F03
```

### 1.1 Streaming model: partials → final

The ASR engine emits **partial hypotheses** continuously (every ~100–300 ms) and
**stabilizes** them into finals at endpoints. Endpointing is a fusion of: Silero
VAD silence (from `AudioFrame.audio_meta`, Team 1), model-native end-of-utterance
signals, and a max-segment-duration cap (~8 s) so very long turns still produce
finals. Each emission is a `TranscriptSegment` with incrementing `rev`; the final
sets `is_final=true` (data-contracts §3.1). This is what lets F03 render live
text and F02 begin extraction on stabilized finals.

### 1.2 Diarization paths (two regimes)

| Regime | Trigger | Method | Quality |
|---|---|---|---|
| **Per-track (preferred)** | Labeled provider (Zoom RTMS / Teams ACS / SFU per-participant tracks) | Each `channel_role`/track *is* a speaker → trivially perfect attribution; map `participant_hint`→`speaker_id` | **best** (DER ~0) |
| **Single-channel online** | Path-D system-audio (mixed), in-room mic | Streaming speaker embeddings (e.g. **pyannote**/NeMo TitaNet/ECAPA) + **online clustering** with incremental re-assignment; overlap detection | **good, harder** (DER target below) |

For single-channel, we run **online diarization** (low-latency, incremental
clustering) on the hot path and an optional **offline refinement** pass (better
clustering with full-session context) that emits `supersedes` corrections
(data-contracts §3.4) once a session ends or a turn closes — improving labels
without blocking live output.

---

## 2. Hosted vs self-hosted STT (D05 tradeoff table)

| Engine | Type | Streaming | Diarization | Custom vocab/biasing | WER (clean EN) | Partial latency | Cost (~/audio-min) | Notes |
|---|---|---|---|---|---|---|---|---|
| **Deepgram (Nova-3)** | hosted | **yes, low-latency** | yes (live) | yes (keyterms/keywords) | ~5–8% | ~150–300 ms | ~$0.004–0.007 | Best real-time latency/$; strong streaming. **MVP primary.** |
| **AssemblyAI (Universal-Streaming)** | hosted | yes | yes | yes (word boost) | ~5–8% | ~300 ms | ~$0.005–0.01 | Rich features (entities, sentiment); great batch. |
| **Azure Speech** | hosted | yes | yes | yes (phrase lists, custom models) | ~6–9% | ~300–500 ms | ~$0.016 | Enterprise/compliance fit; pairs with Teams ACS. |
| **Google Cloud STT (Chirp/v2)** | hosted | yes | yes | yes (speech adaptation) | ~6–9% | ~300–500 ms | ~$0.016+ | Strong multilingual; pairs with GCP shops. |
| **Whisper-class (large-v3 / -turbo, self-host)** | self-host | **not natively streaming** (chunked w/ overlap) | no (add pyannote) | via prompt/biasing hacks | ~4–7% (batch) | ~500–1500 ms (chunked) | GPU $ only | Best batch accuracy; streaming needs engineering (faster-whisper + VAD chunking). |
| **NVIDIA Parakeet / Canary (NeMo, self-host)** | self-host | **yes** (RNNT/TDT streaming) | NeMo diarizer | yes (WFST/boosting) | ~4–6% (EN) | ~150–300 ms | GPU $ only | Excellent streaming accuracy/latency if you run GPUs; pairs with NeMo diarization. |

### 2.1 Recommendation (D05)

- **MVP hot path: Deepgram Nova-3 (hosted, streaming).** Lowest partial latency
  per dollar, native streaming + live diarization + keyterm biasing, no GPU ops.
  Gets us inside the ≤ 800 ms partial budget on day one with minimal infra.
- **Hosted alternates behind an abstraction:** AssemblyAI (feature depth), Azure
  (Teams/enterprise + EU residency), Google (multilingual) — selectable per
  tenant/region/vertical. We wrap all engines behind a `SttEngine` interface so
  routing is a config decision.
- **Self-hosted path (Year-1+, enterprise/cost): NVIDIA Parakeet/Canary on NeMo**
  for streaming, **Whisper-large-v3-turbo** for batch/offline correction. Justified
  when (a) per-minute hosted cost at D02 scale exceeds amortized GPU cost, (b)
  enterprise/self-host tier (D04) requires in-VNet inference, or (c) a regulated
  vertical forbids third-party audio egress (D10).

**Cost crossover intuition (D02):** at Year-1 (5,000 concurrent × ~50% speaking
× 60 min) ≈ tens of millions of audio-minutes/month. At ~$0.005/min hosted that
is ~$/100k-min ranges that begin to rival a managed GPU fleet — so a **hybrid**
(hosted for burst/long-tail, self-hosted for steady-state base load) is the
north-star posture. Full math is F04's, sized off these numbers.

---

## 3. Domain terminology / biasing (the "jargon" requirement)

The product explicitly spans software/finance/healthcare/legal/science/sports
jargon (IDEA). STT must not mangle "ARR", "EBITDA", "p-value", "voir dire",
"myocardial infarction", "Kubernetes".

| Mechanism | Engine support | Use |
|---|---|---|
| **Keyterm / keyword boosting** | Deepgram keyterms, AssemblyAI word-boost, Azure phrase lists, Google speech-adaptation | Inject tenant + session + domain glossary terms with weights at stream open |
| **Tenant glossary** | all (we own the store) | Per-tenant custom vocabulary (company names, product names, people) |
| **Vertical lexicons** | all | Curated finance/legal/healthcare/tech term packs, auto-selected by detected domain (F02 may hint topic back) |
| **Acronym canonicalization** | post-process (ours) | Tag `domain_terms[]` with `canonical` (e.g. ARR→"Annual Recurring Revenue") for F02 |
| **LLM post-edit (async)** | Haiku-class (D04) | Optional second pass: fix homophones/jargon using session context; emits `supersedes` correction. Off the critical path. |
| **Custom acoustic/LM model** | Azure/Google custom, self-host fine-tune | Year-1+ for heavy verticals |

Biasing terms ride into `TranscriptSegment.domain_terms[]` and per-word
`is_domain_term`, giving F02 a head start on entity/acronym extraction (avoiding
duplicate work — F02 owns `ConceptCard`, but Team 2 hands it pre-tagged spans).

---

## 4. Confidence scoring

- **Word-level:** engine-native posterior per token → `words[].confidence`,
  plus top `alt` when low.
- **Segment-level `confidence`:** duration-weighted mean of word confidences,
  penalized by `no_speech_prob` and overlap. Calibrated (Platt/isotonic) so 0.9
  *means* ~90% correct — raw engine scores are not calibrated across engines, so
  we calibrate per-engine to keep the contract meaningful across the `SttEngine`
  abstraction.
- **`confidence_band`:** `high ≥ 0.85`, `medium 0.6–0.85`, `low < 0.6`. F03 can
  visually flag low/medium; F02 can down-weight low-confidence spans in
  extraction and trigger LLM post-edit.
- **Speaker confidence:** diarization cluster posterior → `speaker.speaker_confidence`.

---

## 5. Language detection + multi-language

- **LID** on the first ~2–3 s (and re-checked periodically) sets
  `TranscriptSegment.language` (BCP-47) + `language_confidence`. Session can also
  pin a language to skip LID.
- **English-first** launch (IDEA non-goals: no exhaustive multilingual
  benchmarking) — but the contract and engine abstraction are multilingual-ready
  on day one (`language` field always populated).
- **Multilingual path:** Deepgram/Google/Azure multilingual models, or
  Whisper/Canary (self-host) for breadth. **Code-switching** (language changes
  mid-sentence) is a known hard case → flagged as open question; MVP detects at
  segment granularity, not intra-word.

---

## 6. Accuracy & real-time targets

| Metric | Definition | MVP target | Year-1 target |
|---|---|---|---|
| **WER** (clean, single speaker, EN) | word error rate | ≤ 10% | ≤ 7% |
| **WER** (meeting / noisy / accented) | — | ≤ 18% | ≤ 12% |
| **WER on domain terms** (with biasing) | error rate on glossary terms | ≤ 12% | ≤ 8% |
| **DER** (per-track / labeled) | diarization error rate | ~0% | ~0% |
| **DER** (single-channel online) | — | ≤ 20% | ≤ 12% |
| **RTF** (real-time factor) | proc-time / audio-time; < 1 = faster than real time | ≤ 0.5 | ≤ 0.3 |
| **Partial latency** (audio-end → first partial) | `timing_meta.audio_end_to_partial_ms` | ≤ 800 ms (D07) | ≤ 500 ms |
| **Final latency** (audio-end → final) | `audio_end_to_final_ms` | ≤ 2.0 s | ≤ 1.2 s |

### 6.1 STT latency breakdown (fits D07 STT partial ≤ 800 ms)

| Stage | p50 | p95 |
|---|---|---|
| AudioFrame arrival → engine ingest | 20 ms | 50 ms |
| Streaming ASR partial emit | 200 ms | 450 ms |
| Diarization (per-track) | 5 ms | 15 ms |
| Diarization (single-channel online) | 80 ms | 200 ms |
| Fusion + ITN + confidence + domain tag | 30 ms | 70 ms |
| **STT partial total (per-track)** | **~260 ms** | **~590 ms ✔** |
| **STT partial total (single-channel)** | **~330 ms** | **~770 ms ✔ (≤ 800)** |

Single-channel diarization eats most of the slack — another reason to prefer
labeled-provider per-track audio (Team 1 §3).

---

## 7. Risks

| # | Risk | L | I | Mitigation |
|---|---|---|---|---|
| R1 | Single-channel DER too high → wrong speaker labels | high | high | Prefer per-track; offline refinement supersede; gate "speaker-labeled" claims behind labeled providers |
| R2 | Hosted STT cost explodes at scale | medium | high | Hybrid self-host (Parakeet) for base load; per-tenant engine routing |
| R3 | Jargon/acronym mis-recognition hurts downstream explanations | high | medium | Multi-layer biasing + LLM post-edit + `confidence_band` flagging |
| R4 | Hosted vendor sends audio off-platform (privacy/regulated) | medium | severe | Self-host engine for regulated tenants (D10); BAA/DPA (manual tasks) |
| R5 | Partial→final revisions cause UI flicker / F02 churn | medium | medium | Stabilization hysteresis; F02 acts on finals; partials best-effort (contract §3.5) |
| R6 | Overlapping speech (cross-talk) | high | medium | Overlap detection flag `is_overlap`; per-track avoids it; BSS future |
| R7 | Calibration drift across engines | medium | low | Per-engine calibration; monitor confidence vs measured error |
| R8 | Vendor model version changes shift WER/format | medium | medium | Pin `model_version`; regression eval gate before rollout |

---

## 8. Scalability (against D02)

Unit = streaming STT session (one decoder stream per active speaker-channel).

| Tier | Concurrent sessions | Active decode streams (~1.4/session) | Hosted: API concurrency | Self-host: GPU (A10/L4, ~30–60 streams/GPU) | Diarization workers (CPU/GPU) |
|---|---|---|---|---|---|
| MVP | 200 | ~280 | hosted (no infra) | n/a | 2–3 |
| Year-1 | 5,000 | ~7,000 | hosted + burst | ~120–230 GPU if self-host | ~30 |
| North-star | 50,000 | ~70,000 | hybrid | ~1,200–2,300 GPU base, hosted burst | ~300 |

- **Partition by `session_id`** (matches Team 1 / D08); a session's frames route
  to one decoder for ordering.
- **Backpressure:** shed partials, protect finals (contract §3.5); autoscale
  decoder workers on stream lag.
- **Regional (D03):** decoders colocate with ingest in-region; no cross-region
  audio (privacy + latency).

---

## 9. Cost (audio-minute basis, D02)

| Tier | Audio-min/mo (≈ concurrent × 50% speech × 60min × peak-hours model) | Hosted @ ~$0.005/min | Self-host GPU equiv | Recommendation |
|---|---|---|---|---|
| MVP | ~1–3 M | ~$5k–15k/mo | not worth ops | **hosted** |
| Year-1 | ~30–80 M | ~$150k–400k/mo | ~$80k–200k/mo (GPU fleet) | **hybrid tilt to self-host** |
| North-star | ~300–800 M | ~$1.5M–4M/mo | ~$0.6M–1.5M/mo | **self-host base + hosted burst** |

> STT is one of the two largest cost centers (with F02 LLM). The self-host
> crossover lands around Year-1; this justifies investing in the NeMo/Parakeet
> path before north-star. Exact fleet sizing is F04's, using these numbers.

---

## 10. Security (D10)

- Audio leaving to a **hosted** STT vendor is a data-egress + processing event →
  requires DPA/BAA per vendor (manual tasks); regulated tenants pinned to
  **self-hosted** in-VNet inference.
- `TranscriptSegment` is PII-bearing text → encrypted in transit (mTLS) and at
  rest (Key Vault, F04/F09).
- `consent.mode` passthrough honored: `transcript_only` keeps text but no audio;
  `no_audio_retention` ensures the decoder never persists frames.
- PII redaction hook in fusion stage (`pii_redacted` flag) — policy owned by F09.

---

## 11. MVP scope

**In:** Deepgram Nova-3 streaming (partials+finals, word times, live
diarization); per-track diarization for Zoom RTMS; single-channel online
diarization for desktop system-audio; tenant glossary + keyterm biasing; LID;
calibrated confidence + bands; domain-term tagging; `TranscriptSegment` emission
to D08 stream. English.

**Out (MVP):** self-hosted GPU fleet; LLM post-edit; offline diarization
refinement; multilingual production; custom acoustic models; n-best lattice export.

## 12. Future enhancements

- Self-hosted Parakeet/Canary + Whisper-turbo (cost + privacy).
- Async LLM post-edit (Haiku) for jargon/homophone repair via supersede.
- Offline diarization refinement + cross-session speaker re-ID (with F09 privacy
  review).
- Multilingual + code-switching; per-vertical custom models.
- N-best lattice export to F02 for domain disambiguation (contract DC-3).
- Emotion/sentiment/prosody tags (could enrich F02 insights).

## 13. Assumptions

- Deepgram (or equivalent) meets ≤ 800 ms partials at D02 concurrency.
- Per-track audio is available for flagship integrations (Team 1 §3).
- English-first (IDEA); contract is multilingual-ready regardless.
- F09 owns redaction/consent policy; Team 2 honors flags.
- D08 stream provides ordering; F04 provisions it.

## 14. Decisions

1. Hosted Deepgram Nova-3 for MVP hot path; multi-engine behind `SttEngine`.
2. Hybrid hosted+self-host (Parakeet/Whisper) from Year-1 for cost/privacy.
3. Two diarization regimes: per-track (preferred) + single-channel online
   (fallback) + offline refinement via supersede.
4. Calibrated, banded confidence in the contract.
5. Multi-layer biasing; pre-tagged `domain_terms[]` handed to F02.
6. Endpointing = VAD ⊕ model EOU ⊕ max-duration.

## 15. Tradeoffs

| Choice | Gain | Give-up |
|---|---|---|
| Hosted MVP | speed-to-market, no GPU ops | per-minute cost, audio egress |
| Self-host later | cost@scale, privacy | GPU ops complexity |
| Online single-channel diarization | universal coverage | higher DER, latency |
| LLM post-edit | jargon accuracy | extra cost, supersede churn (kept async) |
| Aggressive endpointing | lower final latency | risk of premature cut-offs |

## 16. Open questions

| # | Question | Needs |
|---|---|---|
| Q1 | Single-channel DER bar to call output "speaker-labeled" in UI? | product/F05 + F03 |
| Q2 | Cost crossover month for self-host — commit GPU fleet when? | F04 |
| Q3 | Expose n-best lattice to F02 (DC-3) or top-1 + `alt`? | F02 |
| Q4 | Code-switching support timeline / which markets? | F05 |
| Q5 | BAA-covered hosted STT vendor for healthcare, or self-host only? | F09 + legal |

## 17. Estimated complexity

| Component | Complexity |
|---|---|
| Hosted streaming STT integration | **M** |
| `SttEngine` abstraction (multi-vendor) | **M** |
| Endpointing + partial/final fusion | **M-L** |
| Per-track diarization | **S-M** |
| Single-channel online diarization | **L** |
| Offline refinement + supersede | **M** |
| Biasing + glossary + domain tagging | **M** |
| Confidence calibration | **M** |
| Self-hosted GPU fleet (future) | **L** |

(Complexity scale: S < M < L.)
