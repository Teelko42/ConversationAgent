/**
 * Golden-object builders for the contract-test suites. Every builder returns a
 * VALID instance; tests override single fields to exercise edges. Kept in
 * @aizen/contracts so all seam packages share one definition of "valid".
 */
import type { TranscriptSegment } from './transcript-segment.js';
import type { ConsentContext } from './consent.js';
import type { ConceptCard } from './concept-card.js';
import type { KgDelta } from './kg.js';
import type { Account, Identity, SavedSession } from './account.js';
import type { ExplanationSource } from './sentence-explanation.js';
import type { UserSource } from './user-source.js';

export const TENANT = '11111111-1111-4111-8111-111111111111';
export const SESSION = '22222222-2222-4222-8222-222222222222';
export const ACCOUNT = '33333333-3333-4333-8333-333333333333';
export const segId = (seq: number) => `${SESSION}:seg:${seq}`;

export function makeTranscriptSegment(
  over: Partial<TranscriptSegment> = {},
): TranscriptSegment {
  return {
    schema_version: '1.0.0',
    tenant_id: TENANT,
    session_id: SESSION,
    seq: 101,
    producer_id: 'stt-worker-3',
    emitted_at: 1748707201987000,
    segment_id: segId(101),
    rev: 3,
    is_final: true,
    supersedes: null,
    start_ms: 256480,
    end_ms: 258120,
    session_start_at: 1748706943000000,
    text: 'So the quarterly ARR.',
    language: 'en-US',
    confidence: 0.91,
    confidence_band: 'high',
    speaker: {
      speaker_id: 'spk_2',
      speaker_confidence: 0.88,
      participant_id: 'p_03',
      display_name: 'Speaker 2',
      channel_role: 'remote_participant',
      is_overlap: false,
      diarization_method: 'online_clustering',
    },
    consent: { mode: 'store_audio', consent_id: 'c_88', pii_redacted: false },
    ...over,
  } as TranscriptSegment;
}

export function makeConsentContext(over: Partial<ConsentContext> = {}): ConsentContext {
  return {
    session_id: SESSION,
    jurisdiction_mode: 'all-party',
    consent_class: 'standard',
    pii_present: false,
    disclosure_scope: 'third_party_stt',
    per_speaker: { spk_2: 'consented' },
    ...over,
  };
}

export function makeConceptCard(over: Partial<ConceptCard> = {}): ConceptCard {
  return {
    id: 'cc_01HW000000000000000000000',
    revision: 1,
    state: 'enriched',
    session_id: SESSION,
    tenant_id: TENANT,
    surface_form: 'ARR',
    canonical_name: 'Annual Recurring Revenue',
    kind: 'acronym',
    domain: 'finance',
    salience: 0.82,
    sources: [
      {
        citation_id: 'ct_1',
        type: 'transcript',
        transcript_segment_ids: [segId(101)],
        snippet: 'So the quarterly ARR.',
        trust_tier: 'T1',
        support_score: 0.9,
      },
    ],
    first_mention: { segment_id: segId(101), t_start_us: 256480000, speaker_id: 'spk_2' },
    mention_segment_ids: [segId(101)],
    consent_class: 'standard',
    pii_present: false,
    retraction: null,
    ...over,
  } as ConceptCard;
}

export function makeAccount(over: Partial<Account> = {}): Account {
  return {
    id: ACCOUNT,
    tier: 'free',
    workspace_id: ACCOUNT,
    display_name: 'Local Dev',
    created_at_us: 1748706943000000,
    updated_at_us: 1748706943000000,
    ...over,
  } as Account;
}

export function makeIdentity(over: Partial<Identity> = {}): Identity {
  return {
    id: '44444444-4444-4444-8444-444444444444',
    account_id: ACCOUNT,
    provider: 'stub',
    provider_subject: 'stub-user',
    email: 'dev@localhost',
    display_name: 'Local Dev',
    created_at_us: 1748706943000000,
    ...over,
  } as Identity;
}

export function makeSavedSession(over: Partial<SavedSession> = {}): SavedSession {
  return {
    id: SESSION,
    account_id: ACCOUNT,
    title: 'Quarterly review',
    artifact_count: 1,
    consent_class: 'standard',
    pii_present: false,
    created_at_us: 1748706943000000,
    updated_at_us: 1748706943000000,
    expires_at_us: null,
    ...over,
  } as SavedSession;
}

export function makeExplanationSource(over: Partial<ExplanationSource> = {}): ExplanationSource {
  return {
    citation_id: 'ct_seg_web_0',
    type: 'web',
    url: 'https://example.com/arr',
    title: 'Investopedia',
    snippet: 'ARR is annual recurring revenue.',
    support_score: 0.9,
    ...over,
  } as ExplanationSource;
}

export function makeUserSource(over: Partial<UserSource> = {}): UserSource {
  return {
    id: 'us_1',
    title: 'Q4 launch brief',
    url: 'https://example.com/brief',
    text: 'We are discussing the Q4 product launch plan.',
    ...over,
  } as UserSource;
}

export function makeKgDelta(over: Partial<KgDelta> = {}): KgDelta {
  return {
    session_id: SESSION,
    delta_seq: 1,
    upsert_nodes: [],
    upsert_edges: [],
    remove_node_ids: [],
    remove_edge_ids: [],
    snapshot_offer: false,
    ...over,
  };
}
