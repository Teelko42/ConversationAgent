---
title: Consent and Privacy
aliases: [Consent, Privacy, ConsentGate, D18, D19, D20, team-09, Fail-closed]
tags: [runtime, core, security, privacy, f04]
created: 2026-06-05
---

# Consent and Privacy

> [!abstract] Privacy is first-class, not bolted on (D10)
> Two-party-consent recording laws apply, so consent is a **per-speaker predicate**
> (D18), the PII gate is **fail-closed** (D20), and the cross-session evidence cache
> **holds no personal data** (INV-9). The architecture is *parameterized* to accept the
> still-pending legal answers (the consent matrix, DPAs) without rework.

This is the code-side of blueprint **doc 13** and lane **F09 (team-09)**. The
[[Data Contracts|consent contracts]] live in `@aizen/contracts/src/consent.ts`; the gate
lives in `@aizen/edge-gateway`.

---

## The fail-closed ingress gate

Before *any* bus or worker exists for a session, the `ConsentGate` decides admission. If
it refuses, the session is rejected and the socket closed — **nothing enters the
pipeline without affirmative consent** (INV-A4 / D20).

```ts
// in createSession (the live app) and SessionConductor.start (the spine):
if (!new ConsentGate().admit(sessionId, consent)) {
  throw new Error('consent refused (fail-closed)');   // no bus is even created
}
```

This is the first of several "the safe error is the default" choices that recur across
Aizen (see [[System Architecture|design principles]]).

---

## Consent is per-speaker (D18)

The original model treated consent as one session-wide flag. **D18** re-models it as a
state held per `(session, speaker_id)` with a continuously-evaluated `may_capture()`
predicate:

```ts
SpeakerConsentState = 'detected' | 'pending' | 'consented' | 'refused' | 'revoked' | 'exempt'
```

- New-speaker detection (from [[Audio Capture and STT|F01 diarization]]) wires to a
  consent **re-check**.
- Per-speaker **revocation** stops that speaker without killing the session
  (revocation is *prospective*; prior disclosure is irreversible).
- In **all-party** jurisdictions, if any detected speaker is unconsented, capture
  continues only on **per-track** topologies (masking that track) and otherwise **blocks
  the mixed stream** — you cannot surgically remove one voice from a mix.

**D19** gates the meeting-bot to single-party jurisdictions at MVP (audible disclosure ≠
affirmative consent), and splits the disclosure badge by what actually happens to the
audio (`disclosure_scope ∈ {self_host, third_party_stt, third_party_stt_llm}`).

---

## The fail-closed PII gate (D20)

The `consent_class` (`standard` | `sensitive`) and `pii_present` flags decide whether
content may leave to external retrieval (INV-6). They are set by **two OR-combined
signals**: the F04 consent context (by tenant vertical/jurisdiction) and a layered
PII/PHI classifier (deterministic recognizers + NER + Azure AI Language for health).

> [!danger] Fail closed, always
> If the classifier is **missing / errored / timed-out**, the result is
> `pii_present = true` (treat as sensitive). Recall is prioritized over precision:
> **≥ 0.95 PII / ≥ 0.98 PHI** — over-suppression is the *safe* error. The classifier runs
> on the deep (≤10 s) path, not the ≤1 s hot path.

The same fail-closed rule lives in the [[Correction Seams|D16 adapter]]: an **absent
`ConsentContext`** stamps `{ consent_class: 'sensitive', pii_present: true }` rather than
inventing `'standard'`.

```ts
const FAIL_CLOSED = { consent_class: 'sensitive', pii_present: true } as const;  // INV-A4
```

---

## Consent flows forward, never relaxes (the account layer)

The [[The Account System|account system]] **adds to, never bypasses** this model:

- A saved resource carries the live session's `consent_class`/`pii_present` **forward**,
  and gets an `expires_at_us` retention deadline from the tier's window — the quota is the
  *concurrent ceiling*; retention still expires the data.
- The save routes are **server-determined and fail-closed**: a client may only **upgrade**
  a save to `'sensitive'`, never downgrade. Accounts never relax team-09.

```ts
// server: POST /api/sessions and /api/sources
const sensitive = body.consent_class === 'sensitive';   // upgrade-only
consentClass: sensitive ? 'sensitive' : 'standard', piiPresent: sensitive
```

---

## BYO source privacy (team-09)

Your pasted notes, files, and Obsidian vault are **conversation data** and ride the same
posture as the transcript: kept **client-side and in-memory**, only the
[[S0 - Source Library and Retrieval|S0-selected chunks]] are shipped per request, and raw
text is **never logged** server-side. Server-side persistence of sources is **opt-in
only** and byte-quota-gated. Obsidian access is **read-only, always**. See
[[F4 - Obsidian Vault Connection]].

---

## INV-9 — the shared cache holds no personal data

The cross-session web/evidence cache (keyed by `canonical_name + domain`, reused
cross-tenant) stores **only generic reference content** — never transcript-derived or
tenant-internal content, and never a raw PII-bearing query in a key. This makes the
shared cache **DSAR-exempt by construction** and prevents a PII false-negative from
leaking into un-erasable shared storage.

---

## Related
- [[Data Contracts]] — the `ConsentContext` / `SpeakerConsent` shapes
- [[The Event Bus]] — the gate runs before the bus is created
- [[Correction Seams]] — the D16 adapter's fail-closed stamping
- [[The Account System]] — consent carried forward into saved resources
- [[Architecture Decisions|D10 / D18 / D19 / D20 / INV-9]]
