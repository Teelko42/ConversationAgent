import { describe, it, expect } from 'vitest';
import {
  TranscriptSegmentSchema,
  ConceptCardSchema,
  InsightItemSchema,
  type InsightItem,
  makeTranscriptSegment,
  makeConceptCard,
  SESSION,
  TENANT,
  segId,
} from './index.js';

describe('contract schemas — round-trip & invariants', () => {
  it('a golden TranscriptSegment validates', () => {
    expect(TranscriptSegmentSchema.safeParse(makeTranscriptSegment()).success).toBe(true);
  });

  it('rejects end_ms < start_ms (media-clock invariant)', () => {
    const bad = makeTranscriptSegment({ start_ms: 5000, end_ms: 4000 });
    expect(TranscriptSegmentSchema.safeParse(bad).success).toBe(false);
  });

  it('INV-8: state=retracted requires a retraction block', () => {
    const noBlock = makeConceptCard({ state: 'retracted', retraction: null });
    expect(ConceptCardSchema.safeParse(noBlock).success).toBe(false);

    const ok = makeConceptCard({
      state: 'retracted',
      retraction: {
        reason: 'source_superseded',
        superseded_segment_id: segId(101),
        replacement_card_id: null,
      },
    });
    expect(ConceptCardSchema.safeParse(ok).success).toBe(true);
  });

  it('INV-8: a retraction block without state=retracted is rejected', () => {
    const bad = makeConceptCard({
      state: 'enriched',
      retraction: {
        reason: 'merged',
        superseded_segment_id: segId(101),
        replacement_card_id: null,
      },
    });
    expect(ConceptCardSchema.safeParse(bad).success).toBe(false);
  });
});

describe('CT-M2 — F02↔F03 InsightItem name reconciliation (doc 10 §4)', () => {
  // F02 names are authoritative; F03 must bind these, NOT the stale
  // kind/assignee/ts_start names.
  const insight: InsightItem = {
    id: 'ii_01HW000000000000000000000',
    revision: 2,
    session_id: SESSION,
    tenant_id: TENANT,
    insight_type: 'action_item',
    status: 'open',
    text: 'Send the revised pricing model to legal by Friday.',
    owner_speaker_id: 'spk_3',
    evidence_segment_ids: [segId(101)],
    first_seen_t_us: 256480000,
    consent_class: 'standard',
    pii_present: true,
  };

  it('binds the authoritative F02 names', () => {
    const parsed = InsightItemSchema.parse(insight);
    expect(parsed.insight_type).toBe('action_item'); // NOT `kind`
    expect(parsed.owner_speaker_id).toBe('spk_3'); // NOT `assignee`
    expect(parsed.first_seen_t_us).toBe(256480000); // NOT `ts_start/ts_end`
  });

  it('rejects an insight with empty evidence (INV-4)', () => {
    expect(
      InsightItemSchema.safeParse({ ...insight, evidence_segment_ids: [] }).success,
    ).toBe(false);
  });

  it('does NOT accept the stale F03 field names as the contract', () => {
    const stale = {
      ...insight,
      kind: 'action_item',
      assignee: 'spk_3',
      ts_start: 1,
    } as Record<string, unknown>;
    // zod strips unknown keys by default; the authoritative fields must still be
    // the ones present. The stale aliases are NOT recognized.
    const parsed = InsightItemSchema.parse(stale);
    expect('kind' in parsed).toBe(false);
    expect('assignee' in parsed).toBe(false);
  });
});
