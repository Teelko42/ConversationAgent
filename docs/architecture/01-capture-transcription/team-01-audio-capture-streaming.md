# Team 1 — Audio Capture & Streaming

> Lane **F01** · Aizen ("AI explains the room"). This team owns everything from a
> sound wave hitting a device to a normalized, ordered `AudioFrame` stream
> arriving at the STT layer (Team 2). It is the literal head of the pipeline.
>
> Budget anchor (D07): **capture + stream ≤ 500 ms** of the 3 s p50 / 5 s p95
> end-to-end target. Scale anchors (D02): 200 / 5,000 / 50,000 concurrent
> sessions. Cloud (D03): Azure eastus primary. Privacy (D10): consent and
> no-audio-retention are first-class.

---

## 1. Architecture

### 1.1 Capture surfaces (D11: web primary, desktop, mobile)

```
                         ┌─────────────────────── CLIENTS ───────────────────────┐
  microphone ──┐         │ Web (PWA)      Desktop (Tauri)     Mobile (iOS/Android)│
  system audio ┼─ AEC ──►│ getUserMedia   WASAPI loopback     AVAudioEngine /     │
  meeting feed ┘  NS/VAD │ + WebRTC       CoreAudio tap       AudioRecord +       │
                         │                ScreenCaptureKit    ReplayKit/MediaProj │
                         └───────────────┬───────────────────────────────────────┘
                                         │  Opus/WebRTC (or WS framed PCM)
                                         ▼
                 ┌──────────────────────────────────────────────────┐
                 │           EDGE INGEST GATEWAY (Azure)             │
                 │  SFU (mediasoup/Janus) | API GW WS | gRPC ingest  │
                 │  • decode Opus→PCM  • resample 48k→16k mono       │
                 │  • per-participant channel split                  │
                 │  • server-side VAD + AGC + denoise (RNNoise/DTLN) │
                 │  • assign seq, stamp media time, build AudioFrame │
                 │  • consent gate (D10): drop/route per mode        │
                 └───────────────┬──────────────────────────────────┘
                                 │ AudioFrame (100ms batched, ordered)
                                 ▼
                 ┌──────────────────────────────────────────────────┐
                 │  Per-session ordered stream (D08, Kafka-class)    │
                 │  partition key = session_id                       │
                 └───────────────┬──────────────────────────────────┘
                                 ▼     Team 2 (STT + diarization)
```

### 1.2 Why a server-side SFU + server-side preprocessing

A **thin client / heavy server** posture (D11) means clients do the minimum
reliable capture and ship audio; normalization, VAD, denoise, channel split, and
`seq` assignment happen **once, server-side**, so all three platforms and all
meeting providers converge on **one** `AudioFrame` definition. This avoids
per-platform drift in the data contract and lets us upgrade DSP without shipping
client releases. Clients still run **echo cancellation (AEC) locally** because
AEC needs the device's own playback reference signal, which only exists on-device.

### 1.3 Capture-source matrix

| Source | Web | Desktop (Tauri/Electron) | Mobile |
|---|---|---|---|
| Microphone | `getUserMedia({audio})` w/ browser AEC/NS/AGC | OS mic API (WASAPI / CoreAudio / ALSA) | `AVAudioEngine` (iOS) / `AudioRecord` (Android) |
| System / desktop audio | **not generally possible** (no loopback in browser; `getDisplayMedia` audio is tab-only, inconsistent) | **yes** — WASAPI loopback (Win), ScreenCaptureKit/CoreAudio tap (macOS 13+), PulseAudio/PipeWire monitor (Linux) | **constrained** — iOS ReplayKit (in-app/broadcast only, no arbitrary system audio); Android `MediaProjection` + `AudioPlaybackCapture` (API 29+, apps can opt out) |
| Joining a meeting | via meeting bot/SDK (see §3) | via meeting bot/SDK or system-audio of the running meeting client | via mobile meeting SDK or screen-broadcast capture |

**Key architectural consequence:** system-audio capture (hearing the *other*
side of a call without a meeting integration) is a **desktop-first** capability.
On web it is effectively unavailable; on mobile it is restricted and
app-cooperative. This drives the desktop app's strategic importance for the
"sit in any call" use case (see §3 and Product/F05).

### 1.4 Desktop system-audio detail

| OS | API | Notes |
|---|---|---|
| Windows | **WASAPI loopback** (`AUDCLNT_STREAMFLAGS_LOOPBACK`) | Captures the render mix per-device. No driver install. Process-specific loopback available on Win 10 2004+ via `ActivateAudioInterfaceAsync`. |
| macOS | **ScreenCaptureKit audio** (macOS 13+) / Core Audio taps (macOS 14.4+ `CATap`) | Clean, entitlement-gated. Pre-13 fallback historically needed a virtual driver (e.g. BlackHole); we target 13+. Requires Screen Recording permission. |
| Linux | PipeWire / PulseAudio **monitor** source | Straightforward; enterprise Linux desktops. |

A **virtual audio device** (install a loopback driver, route everything through
it) is an alternative on older OSes but adds an install/driver-signing burden and
is brittle; we treat it as a **fallback**, not the primary path.

### 1.5 Preprocessing chain (server-side, per `channel_role`)

```
PCM 16k mono ─► HPF(80Hz) ─► Denoise(RNNoise/DTLN) ─► AGC ─► VAD(Silero) ─► frame+stamp ─► AudioFrame
                                                          │
                                                          └─ vad_prob, rms_dbfs, snr_est → audio_meta
```

- **HPF** removes rumble/DC.
- **Denoise**: RNNoise (cheap, ~real-time on CPU) for MVP; DTLN/deep models
  evaluated at scale where GPU headroom exists. Denoise is **conservative** —
  over-aggressive NS hurts WER, so we tune for SNR gain without spectral
  smearing and let the STT model see near-original audio (Team 2 prefers
  lightly processed input).
- **AEC**: on-device only (needs playback reference). The SFU additionally
  applies cross-stream echo suppression when mixing isn't separable.
- **VAD**: **Silero VAD** server-side for endpointing hints and to gate STT
  (don't pay for inference on silence). Per-frame `is_speech`/`vad_prob` ride in
  `audio_meta`. VAD also drives **segmentation hints** consumed by Team 2's
  endpointer.

---

## 2. Streaming protocol choice

The transport from client → edge ingest is the latency-critical hop (most of the
≤ 500 ms budget). Three candidates:

| Dimension | **WebRTC** | **WebSocket (framed PCM/Opus)** | **gRPC bidi streaming** |
|---|---|---|---|
| Transport | UDP (SRTP) + ICE/STUN/TURN | TCP | HTTP/2 (TCP) |
| Latency under loss | **best** (no head-of-line blocking; jitter buffer, FEC, PLC) | poor (TCP HOL blocking, retransmit stalls) | poor (HOL blocking) |
| NAT / firewall traversal | built-in (ICE/TURN) | trivial (443) | good (443) |
| Browser support | native, first-class | native | needs grpc-web/proxy (no native bidi) |
| Audio features | jitter buffer, FEC, AEC reference, bandwidth adaptation | none (DIY) | none (DIY) |
| Multi-party (meeting) | natural via **SFU** | awkward | awkward |
| Implementation cost | high (SFU, signaling, TURN) | low | medium |
| Best fit | **live mic + multi-party + lossy mobile networks** | server↔server, simple desktop, controlled networks | **internal service-to-service** |

**Decision (see Decisions §10):**

- **Client → edge: WebRTC** via an **SFU** (mediasoup or Janus, self-hosted on
  Azure; or a managed SFU like LiveKit) for mic and multi-party. WebRTC's loss
  concealment and jitter handling are decisive on real mobile/Wi-Fi networks and
  keep p95 inside budget. The SFU also gives us per-participant tracks → clean
  `channel_role` separation feeding diarization.
- **Fallback client → edge: WebSocket** with 20–100 ms Opus/PCM frames for
  simple desktop captures and constrained corporate networks where WebRTC UDP is
  blocked (TURN/TCP relay is the first fallback; WS is the floor).
- **Internal (edge ingest → STT workers, STT → downstream): gRPC bidi** for
  backpressure, deadlines, and typed contracts; rides the D08 stream for durable
  ordering. gRPC is wrong at the browser edge but ideal internally.

### 2.1 Latency budget breakdown (fits D07 capture+stream ≤ 500 ms)

| Hop | p50 | p95 | Notes |
|---|---|---|---|
| Mic → client encode (Opus 20 ms) | 25 ms | 40 ms | frame + encode |
| Client → SFU (RTT/2 + jitter buffer) | 60 ms | 180 ms | WebRTC adaptive jitter buffer; mobile worst case |
| SFU → ingest decode + resample | 15 ms | 30 ms | Opus→PCM, 48k→16k |
| Preprocess (HPF/NS/AGC/VAD) | 20 ms | 45 ms | RNNoise + Silero per 100 ms |
| Frame/stamp + enqueue to stream | 10 ms | 25 ms | seq assign, batch 100 ms |
| **Capture+stream total** | **~130 ms** | **~320 ms** | **≤ 500 ms ✔ (headroom for TURN relay)** |

Worst case with a **TURN/TCP relay** (UDP blocked): +80–150 ms — still under 500
ms p95 in most corporate networks; flagged as a risk (§3 risks).

---

## 3. Meeting-platform integration (Zoom / Teams / Meet)

To "sit in a call," four integration archetypes exist. This is the highest-risk,
highest-value area of Team 1.

| Path | How it works | Audio quality | Per-speaker labels | Consent UX | Eng cost | Provider risk |
|---|---|---|---|---|---|---|
| **A. Native meeting bot (recall-style)** | A headless participant joins the meeting (provider SDK / browser automation) and receives the mixed or per-participant media | high; per-participant if SDK supports raw streams | **best** (provider participant ids → `participant_hint`) | bot is visible → strong consent signal; some orgs block bots | high | ToS/SDK changes; bot admission policies |
| **B. Provider streaming API / RTMS** | Provider pushes real-time media+events to us (Zoom **RTMS**, Teams via **Graph/ACS** media, Meet has **no** first-party real-time media API) | high; structured speaker events | excellent on Zoom RTMS / Teams ACS | account-admin enabled; auditable | medium-high | requires marketplace app approval / partner status |
| **C. Meeting-client SDK embedded** | Embed Zoom/Teams SDK in *our* app; user runs the meeting inside Aizen | high | good | explicit in-app | high; per-provider SDK | SDK lock-in, app review |
| **D. Desktop system-audio of the running client** | Capture the OS render mix while the user runs Zoom/Teams/Meet normally (§1.4) | good (post-mix) | **none** (single mixed channel → diarization must infer speakers) | local-only; weakest provider-side consent signal | low (reuse §1.4) | none (provider-agnostic) — **the universal fallback** |

### 3.1 Per-provider reality (2026)

| Provider | Best path | Real-time media? | Speaker events? | Notes |
|---|---|---|---|---|
| **Zoom** | **B (RTMS)** or A (Meeting SDK / Linux bot) | Yes — **RTMS** streams real-time media + transcript + speaker events to approved apps | Yes (RTMS active-speaker + participant ids) | Marketplace app + scopes; admin install for orgs. Best first-party support of the three. |
| **Microsoft Teams** | **B (ACS / Graph real-time media bot)** | Yes — application-hosted media bot via Azure Communication Services / Graph | Yes (per-participant streams) | Heaviest setup; Azure bot registration, tenant admin consent, compliance recording APIs exist. |
| **Google Meet** | **A (bot)** or **D (system audio)** | **No** first-party real-time media stream API (Meet provides post-call artifacts / limited add-on SDK, not raw live audio out) | limited | Live capture for Meet realistically = headless bot or desktop system-audio. Highest fragility. |

**Decision:** MVP ships **Path D (desktop system-audio)** as the universal,
provider-agnostic capture (works for *any* call, including Meet) plus **Path B
for Zoom (RTMS)** as the flagship high-fidelity integration (best per-speaker
data). Teams (ACS) and a generalized bot (Path A) are Phase 2. This sequencing
maximizes coverage early (D) while landing one excellent labeled integration (Zoom).

### 3.2 Consent & two-party-consent law (D10)

Every meeting path MUST capture and stamp consent (`AudioFrame.consent`,
`consent_id`). Bots (Path A/B) make recording **visible** to all participants
(strong legal posture); desktop system-audio (Path D) is invisible to the far
side, so the app MUST enforce an explicit user attestation and, where required,
an audible/visible recording notice. F09 owns the authoritative consent model;
Team 1 emits the touchpoints and honors `no_audio_retention` by never persisting
`payload`.

---

## 4. Technology recommendations

| Concern | MVP pick | At scale | Why |
|---|---|---|---|
| Edge transport | WebRTC via **LiveKit** (managed-or-self-host SFU) | self-hosted **mediasoup** cluster | LiveKit accelerates MVP; mediasoup gives cost control + raw track access at scale |
| Signaling | LiveKit/WebSocket | same | — |
| TURN | coturn on Azure VMs (multi-AZ) | coturn VM scale set + global anycast | UDP-blocked networks |
| Desktop shell | **Tauri** (Rust) | Tauri | smaller, safer, native loopback via Rust crates (cpal/wasapi) vs Electron heft |
| System-audio (Win/mac/Linux) | WASAPI loopback / ScreenCaptureKit / PipeWire monitor | same | native, no driver install |
| Mobile capture | AVAudioEngine (iOS) / AudioRecord + MediaProjection (Android) | same | platform-native |
| Denoise | **RNNoise** | DTLN/deep NS on GPU pool | CPU-cheap MVP; quality at scale |
| VAD / endpointing | **Silero VAD** | Silero + model-native endpoints | accurate, light, ONNX-portable |
| Internal transport | **gRPC** bidi | gRPC + D08 stream | typed, backpressure |
| Event backbone | **Kafka-compatible log (Event Hubs Dedicated)** per D08 (F08 final word) | Event Hubs Dedicated / Event Hubs tiered | durable ordered per-session |
| Meeting (Zoom) | Zoom **RTMS** marketplace app | + Teams ACS, generic bot | first-party speaker data |
| Audio archival | Azure Blob Storage (FLAC) when consent allows | Blob + lifecycle to Archive tier | D09/D10 |

---

## 5. Risks

| # | Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|---|
| R1 | Meeting-provider ToS / API changes break a path | high | high | Multi-path (D fallback always works); abstract behind a `CaptureProvider` interface; monitor marketplace policy |
| R2 | Web cannot capture system audio | certain | medium | Position desktop app for call use cases; web = mic + meeting-bot only |
| R3 | Corporate firewalls block WebRTC UDP | medium | medium | TURN/TCP relay; WS-PCM fallback; both stay < 500 ms p95 |
| R4 | Mobile OS restrictions on background/system audio | high | medium | iOS: in-app + ReplayKit broadcast only; Android: MediaProjection with user gesture; set product expectations |
| R5 | Single mixed channel (Path D) defeats diarization | medium | medium | Prefer per-participant tracks (A/B); Team 2 online diarization as fallback (degraded DER) |
| R6 | Two-party consent violation (legal) | low | severe | Mandatory consent gate (D10/F09); visible bot; audible notice; block capture without `consent_id` |
| R7 | Denoise over-processing raises WER | medium | medium | Conservative NS tuning; A/B WER with NS on/off; let STT see lightly-processed audio |
| R8 | SFU is a scaling/cost hotspot | medium | high | Horizontal SFU sharding by session; autoscale on track count; egress cost modeling (§7) |

---

## 6. Scalability (against D02)

Partition unit = **`session_id`**. Everything scales horizontally per session.

| Tier | Concurrent sessions | Active audio streams (~1.4 tracks/session avg) | SFU nodes (~500 tracks/node) | Ingest/preproc workers (~150 streams/worker) | Stream partitions (Event Hubs) |
|---|---|---|---|---|---|
| MVP | 200 | ~280 | 1–2 | 2–3 | 256 |
| Year-1 | 5,000 | ~7,000 | ~16 | ~50 | 1,024 |
| North-star | 50,000 | ~70,000 | ~150 | ~470 | 4,096+ (multi-cluster, regional) |

- **Bandwidth:** Opus mono ~24–32 kbps/track. North-star inbound ≈ 70,000 ×
  32 kbps ≈ **2.2 Gbps** ingress (plus TURN relay overhead). Modeled in §7.
- **Audio data rate post-normalize:** 16k×16-bit mono = 256 kbps PCM/stream;
  batched 100 ms frames. Internal stream throughput at north-star ≈ 70,000 ×
  256 kbps ≈ **18 Gbps** internal (kept in-region; this is why preprocessing and
  STT colocate with ingest).
- **Regional sharding (D03):** eastus primary, westus DR; westeurope for
  EU residency at Year-1+ — sessions pinned to a home region; no cross-region
  audio.
- **Backpressure:** SFU drops to lower bitrate before dropping frames; internal
  gRPC enforces deadlines; under overload, partials are shed (finals protected
  per data-contract §3.5).

---

## 7. Cost (Azure, D02/D03; order-of-magnitude)

| Item | Unit basis | MVP (200) | Year-1 (5k) | North-star (50k) |
|---|---|---|---|---|
| SFU compute (Dpsv5 Arm) | ~500 tracks/node, ~$0.15/hr/node-eq | ~$0.6/hr | ~$15/hr | ~$140/hr |
| Ingest/preproc (CPU, RNNoise+Silero) | ~150 streams/worker | ~$0.5/hr | ~$12/hr | ~$110/hr |
| TURN relay egress (≈20% sessions relayed) | $0.05–0.09/GB egress | ~$0.1/hr | ~$3/hr | ~$30/hr |
| Event Hubs (Kafka-compatible) | broker hrs + storage | ~$1.5/hr | ~$8/hr | ~$60/hr (multi-cluster) |
| Blob audio archival (consented, FLAC ~5MB/min) | $0.023/GB-mo | negligible | ~$300/mo | ~$3k/mo |
| **Approx capture-layer compute run-rate** | per peak hour | **~$3/hr** | **~$38/hr** | **~$340/hr** |

(SKUs mapped to Azure; dollar figures carried from the original model pending Azure repricing.)

> Capture/stream is a *modest* slice of total cost — STT (Team 2) and LLM (F02)
> dominate. The biggest capture lever is **egress** (TURN + cross-AZ); keep
> media in-AZ where possible and prefer direct WebRTC over relay.

---

## 8. Security (D10 touchpoints)

- **In transit:** SRTP (WebRTC) client→edge; TLS for WS/gRPC; mTLS internal.
- **At rest:** Blob encryption at rest with per-tenant Key Vault customer-managed keys; `no_audio_retention` mode drops
  `payload` after STT (no audio at rest).
- **Consent gate:** ingest refuses frames without a valid `consent_id`; bots
  surface visible recording notice (two-party law, D10).
- **Tenant isolation:** `tenant_id` on every frame; SFU rooms namespaced by
  tenant; stream ACLs per partition.
- **PII:** raw audio is PII-bearing; redaction hooks reserved (F09 owns
  redaction policy). Device labels scrubbed of user-identifying strings where
  not needed.

---

## 9. MVP scope

**In:** Web (mic via WebRTC) + Desktop Tauri (mic **and** system-audio loopback)
+ Zoom RTMS integration. Server-side resample/denoise/VAD. WebRTC primary, WS
fallback, TURN. AudioFrame emission to Event Hubs. Consent gate. iOS/Android mic-only
capture (no system audio at MVP).

**Out (MVP):** Teams/Meet bots; mobile system-audio; deep-NS GPU pool;
multi-region; n-best lattice export.

## 10. Future enhancements

- Teams (ACS) + generic headless meeting bot (Path A); Meet bot.
- On-device VAD/denoise to shave the edge hop for premium clients.
- Per-process Windows loopback (capture only the meeting app).
- Adaptive bitrate driven by measured WER (raise quality when accuracy dips).
- Hardware-offload denoise; spatial/array mic support for in-room meetings.
- Echo/cross-talk separation (BSS) for single-channel Path-D diarization uplift.

## 11. Assumptions

- English-first launch (IDEA); audio format choices (16k mono) suit that.
- Most "call" usage is desktop; mobile is mic-first.
- Zoom RTMS marketplace approval is obtainable (manual task MAN-F01-001/004).
- D08 provides a durable ordered per-session stream; F04 provisions it.
- Consent records are stored by F09; Team 1 only references `consent_id`.

## 12. Decisions

1. Server-side normalization & `seq` assignment → one `AudioFrame` for all
   platforms.
2. WebRTC (SFU) at the edge; WS fallback; gRPC internal. (See §2.)
3. Desktop-first for system audio; web = mic/bot only.
4. MVP meeting coverage = Zoom RTMS (labeled) + universal desktop system-audio.
5. Tauri over Electron for the desktop shell.
6. 16 kHz mono S16LE canonical ASR format; 48 kHz stereo archival when consented.
7. 20 ms capture/VAD granularity, 100 ms batching onto the internal stream.

## 13. Tradeoffs

| Choice | Gain | Give-up |
|---|---|---|
| Server-side preprocessing | one contract, hot-swappable DSP | server CPU cost; +20–45 ms |
| WebRTC + SFU | loss resilience, multi-party, per-track | SFU build/run complexity |
| Desktop system-audio (Path D) | universal, no provider dependency | no speaker labels; diarization must infer |
| Conservative denoise | lower WER | less aggressive noise removal |
| 16 kHz mono | half the bytes, model-native | discards >8 kHz content (fine for speech) |

## 14. Open questions

| # | Question | Needs |
|---|---|---|
| Q1 | Build vs buy the SFU (LiveKit managed vs self-host mediasoup) at Year-1 cost crossover? | F04 cost model |
| Q2 | Do we ship per-process Windows loopback in MVP or accept full-mix? | product/F05 |
| Q3 | Acceptable p95 for TURN-relayed sessions — hard SLA or best-effort? | F04 SLO |
| Q4 | Single-channel (Path D) diarization quality bar — ship or gate behind "labeled providers only"? | Team 2 DER targets |

## 15. Estimated complexity

| Component | Complexity | Note |
|---|---|---|
| Web mic WebRTC capture | **M** | standard getUserMedia + SFU |
| Desktop system-audio (3 OSes) | **L** | per-OS native APIs, entitlements, signing |
| Edge ingest/normalize/preproc | **M-L** | DSP + seq + consent gate |
| SFU operate at scale | **L** | sharding, autoscale, TURN, egress cost |
| Zoom RTMS integration | **L** | marketplace approval + media handling |
| Teams/Meet (future) | **L each** | ACS bot / headless bot fragility |
| Mobile capture | **M** | iOS/Android constraints |

(Complexity scale: S < M < L.)
