import { z } from 'zod';

/**
 * Consent & privacy contracts (doc 13 — D18/D19/D20).
 *
 * Consent is a PER-SPEAKER predicate, not a session scalar (D18). The session's
 * capture authorization is derived from the speaker set via `mayCapture()`
 * (see @aizen/... gate logic). `ConsentContext` is the value the D16 adapter
 * reads to stamp `consent_class`/`pii_present` FAIL-CLOSED (D20).
 */

/** INV-6 gate axis: may this content leave to external retrieval? */
export const ConsentClassSchema = z.enum(['standard', 'sensitive']);
export type ConsentClass = z.infer<typeof ConsentClassSchema>;

/** Where audio actually goes — drives the disclosure badge (D19, H-12). */
export const DisclosureScopeSchema = z.enum([
  'self_host', // no third-party egress; `no_third_party_disclosure` truthful
  'third_party_stt', // audio → hosted STT under DPA
  'third_party_stt_llm', // audio/transcript → hosted STT + LLM under DPA
]);
export type DisclosureScope = z.infer<typeof DisclosureScopeSchema>;

/** Jurisdiction capture mode (D18). */
export const JurisdictionModeSchema = z.enum(['single-party', 'all-party']);
export type JurisdictionMode = z.infer<typeof JurisdictionModeSchema>;

/** Per-speaker consent state machine (D18 §1). */
export const SpeakerConsentStateSchema = z.enum([
  'detected',
  'pending',
  'consented',
  'refused',
  'revoked',
  'exempt', // lawful basis without per-speaker consent; recorded, never inferred
]);
export type SpeakerConsentState = z.infer<typeof SpeakerConsentStateSchema>;

export const ConsentMechanismSchema = z.enum([
  'in_app_ack',
  'audible_disclosure', // disclosure ≠ consent; sufficient only single-party
  'platform_native', // Zoom/Teams/Meet recording-consent acknowledgment
  'verbal_recorded',
  'host_attested', // the host's OWN consent + duty to inform; NOT transferable
]);
export type ConsentMechanism = z.infer<typeof ConsentMechanismSchema>;

/** One speaker's consent record within a session. */
export const SpeakerConsentSchema = z.object({
  session_id: z.string().uuid(),
  speaker_id: z.string(),
  state: SpeakerConsentStateSchema,
  mechanism: ConsentMechanismSchema.nullable(),
  jurisdiction: z.string().nullable(),
  consent_text_version: z.string().nullable(),
  /** wall-clock µs epoch of the last state change. */
  updated_at: z.number().int(),
  /** ref into the immutable consent ledger (non-repudiation, T5). */
  evidence_ref: z.string().nullable(),
});
export type SpeakerConsent = z.infer<typeof SpeakerConsentSchema>;

/**
 * The value supplied to the D16 adapter (doc 10 Seam A §1.3). The adapter stamps
 * `consent_class`/`pii_present` from this; if it is ABSENT the adapter fails
 * closed (sensitive + pii_present=true, INV-A4 / D20).
 */
export const ConsentContextSchema = z.object({
  session_id: z.string().uuid(),
  jurisdiction_mode: JurisdictionModeSchema,
  /** sensitivity for INV-6, from F04 gate (tenant vertical/jurisdiction). */
  consent_class: ConsentClassSchema,
  /** from the D20 PII/PHI classifier (fail-closed default = true). */
  pii_present: z.boolean(),
  disclosure_scope: DisclosureScopeSchema,
  /** per-speaker states keyed by speaker_id. */
  per_speaker: z.record(z.string(), SpeakerConsentStateSchema),
});
export type ConsentContext = z.infer<typeof ConsentContextSchema>;
