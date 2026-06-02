import type { ConsentContext, SpeakerConsentState } from '@aizen/contracts';

/**
 * Fail-closed ingress gate (D18/D20, mirroring adapter-d16 INV-A4).
 *
 * The gateway admits a session's content ONLY when an affirmative
 * `ConsentContext` says it may. When the context is ABSENT we MUST NOT invent
 * "standard"/"consented" — ingress is DENIED (same fail-closed posture the D16
 * adapter takes when it stamps `sensitive`/`pii_present=true`).
 *
 * Consent is a PER-SPEAKER predicate (D18 §1), not a session scalar: a context
 * admits only if EVERY known speaker is in a cleared state and at least one
 * speaker is present. Any `refused`/`revoked`/`pending`/`detected` speaker
 * fails the whole session closed.
 */

/** Per-speaker states that clear a speaker for capture (D18 §1). */
const CLEARED: ReadonlySet<SpeakerConsentState> = new Set<SpeakerConsentState>([
  'consented',
  'exempt', // lawful basis without per-speaker consent; recorded, never inferred
]);

export class ConsentGate {
  /**
   * May this session's content enter the bus? Fail-closed: absent context ⇒
   * `false`; otherwise true iff every per-speaker state is cleared and the set
   * is non-empty.
   */
  admit(_session: string, ctx?: ConsentContext): boolean {
    if (!ctx) return false; // INV-A4 — never invent consent

    const states = Object.values(ctx.per_speaker);
    if (states.length === 0) return false; // nothing affirmatively cleared
    return states.every((s) => CLEARED.has(s));
  }
}
