import { describe, it, expect } from 'vitest';
import {
  ExtractionInputSchema,
  makeTranscriptSegment,
  makeConsentContext,
  segId,
} from '@aizen/contracts';
import { adapt } from './index.js';

describe('Seam A — D16 adapter (CT-A*)', () => {
  it('CT-A1: maps every field; output validates ExtractionInput', () => {
    const seg = makeTranscriptSegment();
    const out = adapt(seg, makeConsentContext());
    expect(ExtractionInputSchema.safeParse(out).success).toBe(true);
    expect(out.segment_id).toBe(seg.segment_id);
    expect(out.lang).toBe(seg.language); // renamed
    expect(out.speaker_label).toBe(seg.speaker.display_name); // unwrapped
    expect(out.speaker_id).toBe(seg.speaker.speaker_id);
    expect(out.consent_mode).toBe(seg.consent.mode);
  });

  it('CT-A2: start_ms ×1000 = t_start_us (integer, media clock)', () => {
    const out = adapt(makeTranscriptSegment({ start_ms: 256480, end_ms: 258120 }), makeConsentContext());
    expect(out.t_start_us).toBe(256480000);
    expect(out.t_end_us).toBe(258120000);
    expect(Number.isInteger(out.t_start_us)).toBe(true);
    expect(out.clock).toBe('media'); // INV-A2
  });

  it('CT-A3: rev/supersedes survive the adapter (H-7 regression guard)', () => {
    const out = adapt(
      makeTranscriptSegment({ rev: 4, supersedes: segId(100) }),
      makeConsentContext(),
    );
    expect(out.rev).toBe(4);
    expect(out.supersedes).toBe(segId(100)); // the field the old spec dropped
  });

  it('CT-A4: non-UUID opaque segment_id does not error (C-2 type-relax)', () => {
    const out = adapt(makeTranscriptSegment({ segment_id: '22222222-2222-4222-8222-222222222222:seg:101' }), makeConsentContext());
    expect(out.segment_id).toContain(':seg:');
    expect(ExtractionInputSchema.safeParse(out).success).toBe(true);
  });

  it('CT-A5: missing ConsentContext ⇒ fail-closed (sensitive + pii_present) [H-13/D20]', () => {
    const out = adapt(makeTranscriptSegment(), undefined);
    expect(out.consent_class).toBe('sensitive');
    expect(out.pii_present).toBe(true);
  });

  it('CT-A5b: present ConsentContext is honored verbatim', () => {
    const out = adapt(
      makeTranscriptSegment(),
      makeConsentContext({ consent_class: 'standard', pii_present: false }),
    );
    expect(out.consent_class).toBe('standard');
    expect(out.pii_present).toBe(false);
  });

  it('CT-A6: required speaker fields are carried; adapter is pure/idempotent', () => {
    const seg = makeTranscriptSegment();
    const a = adapt(seg, makeConsentContext());
    const b = adapt(seg, makeConsentContext());
    expect(a).toEqual(b); // INV-A3 idempotent
    expect(a.speaker_id).toBeTruthy();
    expect(a.participant_id).toBe(seg.speaker.participant_id);
  });
});
