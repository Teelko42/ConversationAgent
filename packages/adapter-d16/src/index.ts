import type {
  TranscriptSegment,
  ConsentContext,
  ExtractionInput,
} from '@aizen/contracts';

/**
 * D16 / Seam A (doc 10 §1) — the ONLY component that sees raw F01 fields.
 *
 * Pure & stateless (INV-A3): `adapt(seg, ctx)` is deterministic and makes no
 * network/store/LLM call. Invariants enforced here:
 *  - INV-A1  rev/supersedes are always carried (H-7 regression guard).
 *  - INV-A2  t_*_us are media-clock µs (×1000 from ms), tagged `clock:'media'`.
 *  - INV-A4  missing ConsentContext ⇒ fail closed (sensitive + pii_present=true).
 *
 * `consent_class`/`pii_present` are NOT on the TranscriptSegment — they come from
 * the F04 ConsentContext (D20). When it is absent we MUST NOT invent "standard".
 */
const FAIL_CLOSED = { consent_class: 'sensitive', pii_present: true } as const;

export function adapt(
  seg: TranscriptSegment,
  consent: ConsentContext | undefined,
): ExtractionInput {
  const sensitivity = consent
    ? { consent_class: consent.consent_class, pii_present: consent.pii_present }
    : FAIL_CLOSED; // INV-A4

  return {
    // identity
    segment_id: seg.segment_id, // opaque string, never parsed (C-2)
    session_id: seg.session_id,
    tenant_id: seg.tenant_id,
    seq: seg.seq,

    // content
    text: seg.text,
    lang: seg.language, // rename language → lang

    // lifecycle / correction — RESTORED (H-7); INV-A1
    is_final: seg.is_final,
    rev: seg.rev,
    supersedes: seg.supersedes,

    // timing — media clock µs (×1000); INV-A2. Integer in, integer out.
    clock: 'media',
    t_start_us: seg.start_ms * 1000,
    t_end_us: seg.end_ms * 1000,

    // speaker — unwrap nested object
    speaker_id: seg.speaker.speaker_id,
    speaker_label: seg.speaker.display_name,
    speaker_confidence: seg.speaker.speaker_confidence,
    participant_id: seg.speaker.participant_id,

    // confidence
    confidence: seg.confidence,
    confidence_band: seg.confidence_band,

    // consent passthrough
    consent_mode: seg.consent.mode,
    consent_id: seg.consent.consent_id,
    pii_redacted_upstream: seg.consent.pii_redacted,

    // derived sensitivity (fail-closed when ctx absent)
    ...sensitivity,
  };
}
