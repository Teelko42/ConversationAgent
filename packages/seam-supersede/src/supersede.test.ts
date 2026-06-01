import { describe, it, expect, vi } from 'vitest';
import {
  makeConceptCard,
  makeTranscriptSegment,
  segId,
  SESSION,
  TENANT,
  type KnowledgeGraphNode,
} from '@aizen/contracts';
import {
  ProvenanceIndex,
  InMemoryArtifactStore,
  propagateSupersede,
  propagateSpeakerRename,
  assertNoSupersededCitations,
  cardCitedSegments,
  type ReExtractor,
} from './index.js';

function seed() {
  const store = new InMemoryArtifactStore();
  const index = new ProvenanceIndex();
  const card = makeConceptCard({
    id: 'cc_x',
    revision: 1,
    graph_node_id: 'kgn_1',
    sources: [
      { citation_id: 'ct_1', type: 'transcript', transcript_segment_ids: [segId(100)] },
    ],
    first_mention: { segment_id: segId(100), t_start_us: 1, speaker_id: 'spk_2' },
    mention_segment_ids: [segId(100)],
  });
  store.putCard(card);
  index.recordCard(card);
  const correction = makeTranscriptSegment({
    seq: 140,
    segment_id: segId(140),
    supersedes: segId(100),
  });
  return { store, index, correction };
}

describe('Seam B — supersede propagation (CT-B*)', () => {
  it('CT-B1: changed concept → re-emit revision++, citation rewritten to the new segment', () => {
    const { store, index, correction } = seed();
    const reExtract: ReExtractor = () => ({ perCard: { cc_x: 'changed' } });

    const r = propagateSupersede(correction, index, store, reExtract);

    expect(r.reEmitted).toHaveLength(1);
    const card = r.reEmitted[0]!;
    expect(card.revision).toBe(2);
    expect(cardCitedSegments(card)).toContain(segId(140));
    expect(cardCitedSegments(card)).not.toContain(segId(100));
  });

  it('CT-B2: removed concept → state=retracted, kg node in remove_node_ids', () => {
    const { store, index, correction } = seed();
    const reExtract: ReExtractor = () => ({ perCard: { cc_x: 'gone' } });

    const r = propagateSupersede(correction, index, store, reExtract);

    expect(r.retracted).toHaveLength(1);
    expect(r.retracted[0]!.state).toBe('retracted');
    expect(r.retracted[0]!.retraction?.superseded_segment_id).toBe(segId(100));
    expect(r.kgDelta.remove_node_ids).toContain('kgn_1');
  });

  it('CT-B3: speaker rename → fast path relabels the KG speaker node, NO re-extraction', () => {
    const store = new InMemoryArtifactStore();
    const speakerNode: KnowledgeGraphNode = {
      id: 'kgn_spk_spk_2',
      revision: 1,
      session_id: SESSION,
      tenant_id: TENANT,
      label: 'Speaker 2',
      node_type: 'speaker',
      concept_card_id: null,
      consent_class: 'standard',
    };
    store.putNode(speakerNode);
    const reExtract = vi.fn();

    const rename = makeTranscriptSegment({
      seq: 141,
      segment_id: segId(141),
      supersedes: segId(101),
      speaker: { ...makeTranscriptSegment().speaker, display_name: 'Alice' },
    });

    const r = propagateSpeakerRename(rename, store);

    expect(r.updatedNodes).toHaveLength(1);
    expect(r.updatedNodes[0]!.label).toBe('Alice');
    expect(r.updatedNodes[0]!.revision).toBe(2);
    expect(reExtract).not.toHaveBeenCalled(); // rename path takes no extractor
  });

  it('CT-B4: after propagation no live card cites the superseded segment (INV-8)', () => {
    const { store, index, correction } = seed();
    propagateSupersede(correction, index, store, () => ({ perCard: { cc_x: 'changed' } }));

    const check = assertNoSupersededCitations(store.liveCards(), new Set([segId(100)]));
    expect(check.ok).toBe(true);
    expect(check.violations).toHaveLength(0);
  });

  it('CT-B5: duplicate supersede delivery is idempotent (no double-retract)', () => {
    const { store, index, correction } = seed();
    const reExtract: ReExtractor = () => ({ perCard: { cc_x: 'gone' } });

    const first = propagateSupersede(correction, index, store, reExtract);
    expect(first.retracted).toHaveLength(1);

    // same (segment_id, rev) arrives again — index entry already moved/dropped
    const second = propagateSupersede(correction, index, store, reExtract);
    expect(second.retracted).toHaveLength(0);
    expect(second.reEmitted).toHaveLength(0);
  });
});
