# Integration · Consent & Privacy Redesign (per-speaker, fail-closed)

> **Purpose.** The validation review (doc 09, H-10/11/12/13, plus L-4/M-9/M-10)
> found the consent and PII controls have the sharpest real-world exposure of any
> gap: consent is modeled **per-session** where the law requires **per-speaker**;
> meeting-bot consent for non-account participants is deferred but the bot is in
> MVP; the "audio not stored" badge is misleading about sub-processors; and the
> INV-6 PII gate keys on a field everyone **assumes is already set** with **no
> classifier** and a likely **fail-open** default. This document re-models consent
> as a per-speaker, continuously-true predicate, designs the PII classifier with a
> recall target and a fail-closed default, fixes the disclosure badge, and closes
> the DSAR cache gap. It closes H-10, H-11, H-12, H-13, L-4, M-9, M-10.
>
> **Status:** Binding privacy/consent design. It tightens the consent model owned
> by F04/Team-09 (§3) and the privacy gate in F02/Team-05 (§1.1) — additive, and
> it supplies the `ConsentContext` that doc 10 Seam A reads. **Jurisdiction
> specifics (the state-by-state matrix) remain a legal-counsel task** (OQ-SEC-3);
> this document fixes the *architecture* so the legal answer plugs in.
>
> **Root cause (one sentence):** the blueprint modeled consent as a **session
> scalar set once at t=0**, but the law treats it as a **per-speaker predicate
> that must be continuously true** — that single modeling error is the source of
> H-10, H-11, and the revocation gap, and is what this redesign reverses.

---

## 1. The reframe: consent is a per-speaker predicate, not a session state

Today (team-09 §3.3): one state machine, one terminal `consented` state, gated
once. There is **no transition** for a late-joiner / new speaker mid-session, and
revocation kills the **whole session** rather than one speaker.

**New model.** Consent is held **per speaker**, and the session's capture
authorization is a *derived predicate* over the speaker set:

```
SpeakerConsent  (per session_id × speaker_id)
  state ∈ { detected, pending, consented, refused, revoked, exempt }
  mechanism      ∈ { in_app_ack, audible_disclosure, platform_native,
                     verbal_recorded, host_attested(*not transferable*) }
  jurisdiction, consent_text_version, timestamp, evidence_ref → consent ledger
```

```
 detected ──require consent──▶ pending ──affirmative──▶ consented ──revoke──▶ revoked
                                  │                          ▲
                                  └── refuse ──▶ refused      └ (re-consent allowed)
 exempt: lawful basis without per-speaker consent (e.g. single-party tenant,
         the account holder's own voice) — recorded explicitly, never inferred.
```

**Session capture predicate** (evaluated continuously, not once):

| Tenant/jurisdiction mode | `may_capture(session)` is true iff … |
|---|---|
| `single-party` | the **account holder** is `consented`; others get **disclosure** (recorded), no per-speaker block |
| `all-party` (CA/FL/IL/PA/WA, EU, …) | **every** `detected` speaker is `consented` **or** `exempt`; any `pending`/`refused`/`revoked` speaker ⇒ that speaker's audio MUST NOT be processed |

The Gateway consent gate (team-09 §3.3, the hard precondition) now evaluates this
predicate **on every speaker-set change**, not just at session start.

### 1.1 New-speaker detection → consent re-check (the missing transition, H-10)

F01 diarization emits session-local `speaker_id`s and an `is_overlap` flag
(F01 data-contracts §3.2). Wire the missing loop:

```
F01 diarization detects a speaker_id never seen this session
   → emit control event  speaker_detected{session_id, speaker_id, t_us}
   → F04 consent service sets SpeakerConsent[new] = detected → pending
   → re-evaluate may_capture():
        single-party → continue (disclosure obligation logged)
        all-party    → new speaker is pending ⇒ GATE that speaker's audio
                       until resolved (see §1.2)
```

This is the "new_speaker_detected → re-gate" transition the old model lacked. It
runs on the `control.session` topic (team-08 §4.3) so it is ordered with the
audio stream.

### 1.2 The masking constraint (an honest limit, not a hand-wave)

In `all-party` mode with a `pending`/`refused`/`revoked` speaker, the system must
process **only consented speakers' audio**. Whether that is *possible* depends on
the capture topology:

| Capture topology | Can we suppress one speaker? | Behavior on an unconsented speaker |
|---|---|---|
| **Per-track** (Zoom RTMS / Teams ACS / SFU per-participant) | **Yes** — drop that participant's track | mask that track; keep capturing consented speakers |
| **Single-channel mixed** (in-room mic, desktop system-audio) | **No** — you cannot surgically remove one voice from a mixed stream pre-diarization | **block capture of the whole stream** until consent obtained |

This is a real architectural constraint the old model never acknowledged: in
all-party jurisdictions, **mixed-audio capture is all-or-nothing**. Therefore:

> **D18 (new) — all-party capture requires per-track audio, else blocks.** In an
> all-party jurisdiction, if any detected speaker is not `consented`/`exempt`,
> capture continues only on **per-track** topologies (masking the unconsented
> track) and otherwise **blocks the stream**. Mixed-audio + all-party + any
> unconsented speaker ⇒ no capture.

### 1.3 Per-speaker revocation (fixes "revocation kills the session")

`revoke(speaker_id)` →
1. **Immediately** stop capturing/processing that speaker (per-track drop; or
   block the mixed stream per §1.2).
2. Stop **new** downstream processing of that speaker's content.
3. Flag that speaker's stored artifacts for deletion per retention policy.
4. **Do not terminate the session** — other consented speakers continue — *unless*
   the revoker is the account holder or the only remaining consented speaker.

This reconciles L-4: revocation is **immediate for capture/processing** and
**policy-driven for stored-artifact deletion**, resolving the §3.2-vs-§6 conflict.
**Prior third-party disclosure is irreversible** — audio already transmitted to a
sub-processor before revocation cannot be recalled; revocation is **prospective**,
and the consent text must say so.

---

## 2. Meeting-bot consent for non-account participants (closes H-11)

The bot records people who never installed Aizen and never see a consent UI. The
only deferred mechanism was an **audible disclosure**, which in all-party states
is generally **not affirmative consent**, and "the host enabled it" is **one party
consenting for others** — exactly what all-party law forbids.

### 2.1 Affirmative-consent mechanisms for non-account participants

| Mechanism | Source | Counts as affirmative in all-party? |
|---|---|---|
| **Platform-native recording consent** (Zoom recording-consent prompt / RTMS consent, Teams compliance-recording consent, Meet recording notice + acknowledgment) | meeting platform | **Yes**, where the platform captures an explicit per-participant acknowledgment → map to `mechanism=platform_native` |
| **Join-time consent interstitial** (bot admits participant only after an in-meeting consent affordance) | Aizen bot | Yes |
| **Recorded verbal consent** ("Does everyone consent to Aizen analyzing this call?" + affirmative responses) | in-call | Yes, with evidence in the ledger |
| **Audible/visible disclosure only** | bot | **No** — disclosure ≠ consent; sufficient only in `single-party` jurisdictions |
| **Host attestation** | host | **No** — records the host's *own* consent + a duty to inform; **never** transferable to others |

### 2.2 The MVP gating decision (resolves the launch-blocking contradiction)

The bot is in MVP scope, but wiring per-participant affirmative consent across
platforms is genuinely hard. Resolution:

> **D19 (new) — the meeting-bot is gated to `single-party` jurisdictions at MVP**
> (audible disclosure is lawful there), and is enabled in `all-party`
> jurisdictions **only** when (a) the capture is **per-track** and (b)
> **platform-native or interstitial affirmative consent** is captured per
> participant (§2.1). Until then, all-party + bot ⇒ blocked. Host attestation is
> recorded but never substitutes for participants' consent.

This converts H-11 from a silent contradiction (bot in MVP, mechanism "open") into
an explicit scope boundary that legal can sign off on (OQ-SEC-3/5).

---

## 3. The disclosure badge: separate "not retained" from "not disclosed" (closes H-12)

"Audio is never written to Blob Storage" is true but **legally non-load-bearing**:
transmitting audio to a hosted STT (Deepgram-class) **is itself** the regulated
disclosure/interception event for wiretap/HIPAA purposes, and the vendor may
buffer or train unless zero-retention is contractually enforced (OQ-SEC-1). The
single "audio not stored" badge conflates two distinct facts.

**Fix — two independent claims, each with its own truth condition:**

| Claim (badge) | Truth condition | What it does NOT assert |
|---|---|---|
| `no_audio_retention` — "Aizen does not store your audio" | audio is ephemeral; never persisted to Blob Storage (team-09 §4) | does **not** assert third parties don't receive it |
| `processing_disclosure` — "Audio is transmitted in real time to our transcription provider (**Deepgram**) under DPA, and is not stored" | sub-processor named (GDPR §7 list) **and** zero-retention DPA in place | — |
| `no_third_party_disclosure` — "Your audio never leaves Aizen's environment" | **self-host STT** path only (no third-party egress) | only truthful for the self-host tier |

- The participant's **consent text must match the actual `disclosure_scope`** — you
  cannot lawfully consent to a disclosure you were not told about. So the
  `ConsentContext` (read by doc 10 Seam A) carries `disclosure_scope ∈
  {self_host, third_party_stt(vendor), third_party_stt+llm}`, and the consent UI
  renders the matching badge set.
- **Regulated / C4 / all-party-strict tenants** default to **self-host STT** so the
  `no_third_party_disclosure` claim is truthful and the disclosure problem
  disappears (ties to doc 11 cost model self-host path and §1.2 masking).
- Until the STT vendor zero-retention DPA is confirmed (OQ-SEC-1, MAN), the badge
  must **not** imply the sub-processor discards audio — it states transmission +
  DPA, nothing stronger.

---

## 4. The INV-6 PII gate: named classifier, recall target, fail-closed (closes H-13)

INV-6 = "`consent_class=sensitive` or `pii_present=true` ⇒ no external retrieval."
Today the gate (team-05 §1.1) keys on `consent_class`, which team-05 **assumes
arrives set** (A01); `pii_present` appears in doc 02 §4 but **nowhere in F02's
pipeline** — no detector, no target, no eval set; and the natural code path is
**fail-open**. Doc 10 Seam A already fixed the *default direction* at the adapter;
this section designs the **classifier and the two signals** themselves.

### 4.1 Two signals, OR-combined (block if either trips)

| Signal | Set by | Basis |
|---|---|---|
| `consent_class` ∈ {standard, sensitive} | **F04 consent context** at session start | tenant vertical (healthcare/legal/finance ⇒ sensitive), session declared type, jurisdiction — **not** inferred per-utterance |
| `pii_present` ∈ {true, false} | **F02 PII/PHI classifier** on transcript + concept span | per-content detection, below |

The gate (team-05 §1.1 query planning) blocks external channels (web, external
internal-doc) when **either** is sensitive/true. Conversation-grounded Pass A is
unaffected (it never fetches externally — team-04 §1.4), so the classifier sits on
the **deep/Pass-B** path only and has the ≤10 s budget, not the ≤1 s enrich
budget — ~50–150 ms is ample.

### 4.2 The classifier (layered detector)

| Layer | Detects | Implementation options |
|---|---|---|
| **Deterministic recognizers** | SSN, credit-card (Luhn), MRN/account patterns, email, phone, DOB | regex + checksums (Presidio-class recognizers) |
| **Statistical NER** | person names, locations, orgs | small NER model (spaCy / open-weight), in-VNet |
| **Regulated-domain entities** | PHI (medical), financial identifiers, legal-party names | Azure **AI Language (Text Analytics for health)** (managed) **or** in-VNet medical NER for self-host/HIPAA tenants |

Runs in-VNet for strict tenants (no third-party call to classify — that would
reintroduce the disclosure problem). Managed (Azure AI Language) acceptable for
standard tenants under DPA.

### 4.3 Recall target (the safety bar) + fail-closed

The failure mode is **leaking PII/PHI to a third-party web search** — so **recall
is prioritized over precision**; over-suppressing external retrieval is the *safe*
error (the deep pass degrades gracefully to parametric+transcript with a visible
"no external sources used (privacy)" note, team-04 §1.4).

| Target | Value | Rationale |
|---|---|---|
| PII recall (standard) | **≥ 0.95** | minimize false-negatives that leak |
| PHI / financial-identifier recall (regulated) | **≥ 0.98** | C4 leak is existential |
| Precision | secondary | false-positives only over-suppress (safe) |
| **Fail-closed default** | missing / errored / timed-out classifier ⇒ `pii_present = true` | reaffirms doc 10 Seam A INV-A4 |

Threshold tuned to the recall target on a **labeled multi-domain eval set** (MAN
task — build transcripts with PII/PHI ground truth across medical/legal/finance/
general). Production monitoring samples a held-out audit for false-negative rate.

> **D20 (new) — INV-6 gate is fail-closed with a named classifier + recall
> targets.** Missing/uncertain ⇒ treat as sensitive. The classifier and its eval
> set are a Phase-0/1 deliverable, not assumed-set input.

---

## 5. DSAR erasure must reach the evidence cache (closes M-9), and the cache must hold no personal data

The cross-session evidence cache (team-05 §1.2 ch. D, §4) is keyed by
`canonical_name + domain` and reused **across sessions and tenants** — but the
DSAR-delete cascade (team-09 §6) is **tenant-scoped**, so subject-derived data
cached there would **not be erased**. This compounds H-13: a PII false-negative
that reaches web search could be cached and then be **un-erasable**.

**Fix — make the shared cache DSAR-exempt by construction:**

> **INV-9 (new) — the cross-session evidence cache contains only generic,
> non-personal reference content (C1/generic T2–T3 background); no C3/C4,
> transcript-derived (T1), or tenant-internal-doc content is ever written to the
> shared cache.** Transcript-grounded and tenant-internal evidence is stored
> **tenant-scoped** (and thus reached by the DSAR cascade).

Enforcement:
- The cache **write path runs the §4 PII classifier** on what it stores; anything
  flagged is **not** shared-cached (tenant-scoped or dropped).
- Cache **keys never contain the raw query** if the query carried PII — key on the
  normalized `canonical_name`, not the user's phrasing.
- This is consistent with team-04 §5 ("only the generic concept explanation is
  shareable cross-tenant") — now stated as an enforced invariant, not a convention.

Net: the shared cache holds no personal data → it is correctly outside the DSAR
cascade, **and** a PII false-negative cannot leak into un-erasable shared storage.

---

## 6. Compliance-claims hygiene register (closes M-10)

BAA/DPA/SCC and SOC2/HIPAA appear in the docs in the same present-tense voice as
engineered controls, blurring "built and testable" with "contractual prerequisite"
and "future certification." Maintain this register; never state a claim from a
lower readiness band as if it were engineered:

| Claim | Band | Status | Owner |
|---|---|---|---|
| Encryption in transit/at rest (TLS 1.3, encryption at rest via Key Vault customer-managed keys) | **(a) engineered + testable** | now | F04 |
| Consent gate blocks capture pre-`consented` (per §1) | (a) engineered + testable | this redesign | F04 |
| No-audio-retention default (ephemeral audio) | (a) engineered + testable | now | F04 |
| INV-6 PII gate, fail-closed (§4) | (a) engineered + testable | Phase 0/1 | F02+F04 |
| RLS / per-tenant CMK isolation | (a) engineered + testable | now | F04 |
| **DPA with customers + sub-processor list** | **(b) contractual prerequisite** | manual (MAN) | legal |
| **BAA (Azure / Anthropic / STT) or self-host** | (b) contractual prerequisite | manual (OQ-SEC-1) | legal+F01 |
| **STT vendor zero-retention** (gates §3 badge) | (b) contractual prerequisite | manual (OQ-SEC-1) | legal |
| **SOC 2 Type I / II** | **(c) future cert (date)** | Type I 3–6 mo; Type II 6–12 mo | sec lead |
| **HIPAA tier** | (c) future cert (date) | 9–18 mo, gated tier | sec lead |
| **State-by-state consent matrix** | (b) prerequisite | manual (OQ-SEC-3) | counsel |

Rule: **marketing/UI render only band-(a) claims as facts.** Band (b)/(c) are
shown as roadmap/contractual, never as live engineered guarantees (aligns with
F05 §10 "never sell a compliance claim we can't back").

---

## 7. How this closes the loop with the other docs

- **Doc 10 Seam A** reads `ConsentContext` — now precisely defined here:
  `{ consent_class, pii_present (post-§4 classifier), per_speaker_states,
  disclosure_scope }`, all **fail-closed** when absent. Seam A's INV-A4 and this
  doc's D20 are the same fail-closed rule at adapter and gate.
- **Doc 11 cost model** — strict/regulated/all-party-strict tenants default to
  **self-host STT** (§1.2, §3), which is the same self-host path the cost model
  prices; the §4 classifier adds a small in-VNet compute line (negligible vs LLM).
- **Doc 12 latency** — the §4 classifier sits on the deep (≤10 s) path, not the
  ≤1 s enrich path, so it does not affect the wedge metric.

## 8. What this does NOT close (intentionally — these are legal/manual, not design)

- **The state-by-state / jurisdiction consent matrix** (OQ-SEC-3) — needs counsel;
  this doc makes the architecture *parameterized* by it (single vs all-party mode
  per jurisdiction), so the legal answer plugs in without redesign.
- **Sub-processor DPAs/BAAs + STT zero-retention contract** (OQ-SEC-1/2, MAN) — the
  §3 badge and §6 register are **conditional** on these; they gate the truthful
  claims but are procurement/legal tasks.
- **The PII eval-set construction** (§4.3) — a labeled-data MAN task; the targets
  and fail-closed default are fixed here, the data is built in Phase 0/1.
- **DPIA** for the audio-capture processing (team-09 §7) — a legal deliverable.

**Decisions to record in `DECISIONS.md`:** **D18** (per-speaker consent + all-party
requires per-track else blocks), **D19** (meeting-bot gated to single-party at MVP;
all-party only with per-track + affirmative consent), **D20** (INV-6 fail-closed +
named classifier + recall targets), plus **INV-9** (shared evidence cache holds no
personal data). These supersede the session-scalar consent model in team-09 §3.3.

**Next concrete step:** ratify D18–D20 + INV-9 in `DECISIONS.md`; implement the
per-speaker `SpeakerConsent` store + `speaker_detected → re-gate` loop and the §4
classifier as Phase-0/1 deliverables; hand the jurisdiction matrix + sub-processor
contracts to legal (the architecture now waits on those answers without needing
rework).

---

*Authored as remediation item 4 of doc 09 (Blueprint Validation Review). Binding
privacy/consent design; jurisdiction specifics and sub-processor contracts are
legal/manual tasks the architecture is now parameterized to accept. Supplies the
ConsentContext for doc 10 and the self-host default for doc 11.*
