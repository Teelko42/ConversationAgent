import { describe, it, expect } from 'vitest';
import {
  TranscriptSegmentSchema,
  ConceptCardSchema,
  InsightItemSchema,
  type InsightItem,
  AccountSchema,
  IdentitySchema,
  SavedSessionSchema,
  QuotaStatusSchema,
  TierSchema,
  ExplanationSourceSchema,
  UserSourceSchema,
  makeTranscriptSegment,
  makeConceptCard,
  makeAccount,
  makeIdentity,
  makeSavedSession,
  makeExplanationSource,
  makeUserSource,
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

describe('account contracts (New_Feature.md §2)', () => {
  it('golden Account / Identity / SavedSession validate', () => {
    expect(AccountSchema.safeParse(makeAccount()).success).toBe(true);
    expect(IdentitySchema.safeParse(makeIdentity()).success).toBe(true);
    expect(SavedSessionSchema.safeParse(makeSavedSession()).success).toBe(true);
  });

  it('Tier is exactly the four packaging tiers (team-10 §1.2)', () => {
    expect(TierSchema.options).toEqual(['free', 'pro', 'team', 'enterprise']);
  });

  it('rejects an Account with a non-uuid id', () => {
    expect(AccountSchema.safeParse(makeAccount({ id: 'not-a-uuid' })).success).toBe(false);
  });

  it('rejects an Identity with an empty provider_subject', () => {
    expect(IdentitySchema.safeParse(makeIdentity({ provider_subject: '' })).success).toBe(false);
  });

  it('SavedSession carries consent forward (account never bypasses team-09)', () => {
    const sensitive = makeSavedSession({ consent_class: 'sensitive', pii_present: true });
    expect(SavedSessionSchema.safeParse(sensitive).success).toBe(true);
    // an invalid consent class is rejected by the shared ConsentClassSchema.
    const bad = makeSavedSession({ consent_class: 'public' as never });
    expect(SavedSessionSchema.safeParse(bad).success).toBe(false);
  });

  it('QuotaStatus allows a null limit (Enterprise configurable)', () => {
    const ok = QuotaStatusSchema.safeParse({
      tier: 'enterprise',
      used: 12,
      limit: null,
      retention_window_days: null,
      exceeded: false,
    });
    expect(ok.success).toBe(true);
  });
});

describe('BYO user sources (New_Feature.md F2 §4)', () => {
  it('a golden web ExplanationSource validates', () => {
    expect(ExplanationSourceSchema.safeParse(makeExplanationSource()).success).toBe(true);
  });

  it('accepts a type:user source with NO url (renders without a link)', () => {
    const userCite = {
      citation_id: 'ct_seg_user_0',
      type: 'user',
      snippet: 'We are discussing the Q4 launch.',
      support_score: 0.5,
    };
    expect(ExplanationSourceSchema.safeParse(userCite).success).toBe(true);
    // a user source MAY also carry a url (a URL-with-comment).
    expect(
      ExplanationSourceSchema.safeParse({ ...userCite, url: 'https://example.com/brief' }).success,
    ).toBe(true);
  });

  it('still requires a url for type:web (INV-1/2)', () => {
    expect(ExplanationSourceSchema.safeParse({ citation_id: 'c', type: 'web', title: 'x' }).success).toBe(
      false,
    );
    expect(ExplanationSourceSchema.safeParse(makeExplanationSource({ url: '' })).success).toBe(false);
  });

  it('rejects malformed sources (unknown type, out-of-range score)', () => {
    expect(ExplanationSourceSchema.safeParse({ citation_id: 'c', type: 'doc', url: 'u' }).success).toBe(
      false,
    );
    expect(
      ExplanationSourceSchema.safeParse({ citation_id: 'c', type: 'web', url: 'u', support_score: 2 })
        .success,
    ).toBe(false);
  });

  it('UserSource round-trips: text required, title/url optional', () => {
    expect(UserSourceSchema.safeParse(makeUserSource()).success).toBe(true);
    expect(UserSourceSchema.safeParse({ id: 'u', text: 'just a pasted note' }).success).toBe(true);
    // text is required.
    expect(UserSourceSchema.safeParse({ id: 'u', title: 'no body' }).success).toBe(false);
  });
});
