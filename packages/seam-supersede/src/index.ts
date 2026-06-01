import type {
  ConceptCard,
  KnowledgeGraphNode,
  KgDelta,
  TranscriptSegment,
} from '@aizen/contracts';

/**
 * Seam B (doc 10 §2 / INV-8) — supersede / correction propagation.
 *
 * The old model dead-ended: F02 extracted on the original final, then never
 * re-extracted when the `supersedes` correction arrived → stale cards citing
 * superseded text (H-8, an INV-1 violation). This module supplies the missing
 * provenance index + propagation algorithm + the `retracted` un-render path.
 *
 * Re-extraction is INJECTED (`ReExtractor`) so the propagation logic is testable
 * without the LLM — the algorithm is the spec; the extractor is pluggable.
 */

// ---------------------------------------------------------------------------
// Provenance index — segment_id → the artifacts that cite it (doc 10 §2.2)
// ---------------------------------------------------------------------------
export interface ProvenanceEntry {
  conceptCardIds: Set<string>;
  kgNodeIds: Set<string>;
  kgEdgeIds: Set<string>;
  insightIds: Set<string>;
}

const emptyEntry = (): ProvenanceEntry => ({
  conceptCardIds: new Set(),
  kgNodeIds: new Set(),
  kgEdgeIds: new Set(),
  insightIds: new Set(),
});

/** Segment ids a card's live provenance points at. */
export function cardCitedSegments(card: ConceptCard): string[] {
  const ids = new Set<string>();
  for (const s of card.sources) for (const t of s.transcript_segment_ids ?? []) ids.add(t);
  if (card.first_mention) ids.add(card.first_mention.segment_id);
  for (const m of card.mention_segment_ids ?? []) ids.add(m);
  return [...ids];
}

export class ProvenanceIndex {
  private readonly bySegment = new Map<string, ProvenanceEntry>();

  private entry(seg: string): ProvenanceEntry {
    let e = this.bySegment.get(seg);
    if (!e) this.bySegment.set(seg, (e = emptyEntry()));
    return e;
  }

  recordCard(card: ConceptCard): void {
    for (const seg of cardCitedSegments(card)) this.entry(seg).conceptCardIds.add(card.id);
  }

  lookup(seg: string): ProvenanceEntry {
    return this.bySegment.get(seg) ?? emptyEntry();
  }

  /** Move a card's index entries from a superseded segment to its replacement. */
  moveCard(cardId: string, fromSeg: string, toSeg: string): void {
    this.bySegment.get(fromSeg)?.conceptCardIds.delete(cardId);
    this.entry(toSeg).conceptCardIds.add(cardId);
  }

  dropCard(cardId: string, seg: string): void {
    this.bySegment.get(seg)?.conceptCardIds.delete(cardId);
  }
}

// ---------------------------------------------------------------------------
// In-memory artifact store (production swaps Aurora/Redis)
// ---------------------------------------------------------------------------
export class InMemoryArtifactStore {
  readonly cards = new Map<string, ConceptCard>();
  readonly kgNodes = new Map<string, KnowledgeGraphNode>();
  private deltaSeq = 0;

  putCard(c: ConceptCard): void {
    this.cards.set(c.id, c);
  }
  putNode(n: KnowledgeGraphNode): void {
    this.kgNodes.set(n.id, n);
  }
  liveCards(): ConceptCard[] {
    return [...this.cards.values()].filter((c) => c.state !== 'retracted');
  }
  nextDeltaSeq(): number {
    return ++this.deltaSeq;
  }
}

// ---------------------------------------------------------------------------
// Re-extraction verdict (injected) — doc 10 §2.3
// ---------------------------------------------------------------------------
export type CardVerdict = 'unchanged' | 'changed' | 'gone';
export interface ReExtractVerdict {
  /** per affected concept-card id: what the corrected text did to it. */
  perCard: Record<string, CardVerdict>;
  /** brand-new concepts the correction introduced. */
  created?: ConceptCard[];
}
export type ReExtractor = (
  supersededSegmentId: string,
  newSegment: TranscriptSegment,
  affected: ProvenanceEntry,
) => ReExtractVerdict;

export interface PropagationResult {
  reEmitted: ConceptCard[];
  retracted: ConceptCard[];
  created: ConceptCard[];
  kgDelta: KgDelta;
}

// --- pure helpers --------------------------------------------------------
export function rewriteCitations(
  card: ConceptCard,
  fromSeg: string,
  toSeg: string,
): ConceptCard {
  const swap = (id: string) => (id === fromSeg ? toSeg : id);
  return {
    ...card,
    revision: card.revision + 1,
    sources: card.sources.map((s) => ({
      ...s,
      transcript_segment_ids: s.transcript_segment_ids?.map(swap),
    })),
    first_mention: card.first_mention
      ? { ...card.first_mention, segment_id: swap(card.first_mention.segment_id) }
      : card.first_mention,
    mention_segment_ids: card.mention_segment_ids?.map(swap),
  };
}

export function retract(card: ConceptCard, supersededSeg: string): ConceptCard {
  return {
    ...card,
    revision: card.revision + 1,
    state: 'retracted',
    retraction: {
      reason: 'source_superseded',
      superseded_segment_id: supersededSeg,
      replacement_card_id: null,
    },
  };
}

/**
 * Propagate an `is_final` segment that carries `supersedes`. Re-emits, retracts,
 * or creates artifacts and returns ONE atomic kg_delta (doc 10 §2.3). Idempotent:
 * once the index entries are moved off the superseded segment, a duplicate
 * delivery finds nothing affected (CT-B5).
 */
export function propagateSupersede(
  newSeg: TranscriptSegment,
  index: ProvenanceIndex,
  store: InMemoryArtifactStore,
  reExtract: ReExtractor,
): PropagationResult {
  const oldSeg = newSeg.supersedes;
  if (oldSeg === null) {
    throw new Error('propagateSupersede called on a segment with supersedes=null');
  }

  const affected = index.lookup(oldSeg);
  const verdict = reExtract(oldSeg, newSeg, affected);

  const reEmitted: ConceptCard[] = [];
  const retracted: ConceptCard[] = [];
  const removeNodeIds: string[] = [];

  for (const cardId of affected.conceptCardIds) {
    const card = store.cards.get(cardId);
    if (!card || card.state === 'retracted') continue;
    const v = verdict.perCard[cardId] ?? 'unchanged';

    if (v === 'changed') {
      const updated = rewriteCitations(card, oldSeg, newSeg.segment_id);
      store.putCard(updated);
      index.moveCard(cardId, oldSeg, newSeg.segment_id);
      reEmitted.push(updated);
    } else if (v === 'gone') {
      const r = retract(card, oldSeg);
      store.putCard(r);
      index.dropCard(cardId, oldSeg);
      if (card.graph_node_id) removeNodeIds.push(card.graph_node_id);
      retracted.push(r);
    } else {
      // unchanged: still rewrite the citation so it no longer points at oldSeg
      const updated = rewriteCitations(card, oldSeg, newSeg.segment_id);
      // unchanged ⇒ keep revision stable except for the provenance move
      updated.revision = card.revision;
      store.putCard(updated);
      index.moveCard(cardId, oldSeg, newSeg.segment_id);
    }
  }

  const created = verdict.created ?? [];
  for (const c of created) {
    store.putCard(c);
    index.recordCard(c);
  }

  const kgDelta: KgDelta = {
    session_id: newSeg.session_id,
    delta_seq: store.nextDeltaSeq(),
    upsert_nodes: [],
    upsert_edges: [],
    remove_node_ids: removeNodeIds,
    remove_edge_ids: [],
    snapshot_offer: false,
  };

  return { reEmitted, retracted, created, kgDelta };
}

/**
 * Speaker-rename fast path (doc 10 §2.3): a supersede touching only
 * `speaker.display_name`. No re-extraction — just relabel KG speaker nodes.
 * Convention: a speaker node has id `kgn_spk_<speaker_id>`.
 */
export function propagateSpeakerRename(
  newSeg: TranscriptSegment,
  store: InMemoryArtifactStore,
): { updatedNodes: KnowledgeGraphNode[]; kgDelta: KgDelta } {
  const nodeId = `kgn_spk_${newSeg.speaker.speaker_id}`;
  const node = store.kgNodes.get(nodeId);
  const updatedNodes: KnowledgeGraphNode[] = [];
  if (node && node.label !== newSeg.speaker.display_name) {
    const updated: KnowledgeGraphNode = {
      ...node,
      label: newSeg.speaker.display_name,
      revision: node.revision + 1,
    };
    store.putNode(updated);
    updatedNodes.push(updated);
  }
  return {
    updatedNodes,
    kgDelta: {
      session_id: newSeg.session_id,
      delta_seq: store.nextDeltaSeq(),
      upsert_nodes: updatedNodes,
      upsert_edges: [],
      remove_node_ids: [],
      remove_edge_ids: [],
      snapshot_offer: false,
    },
  };
}

// ---------------------------------------------------------------------------
// INV-8 guard — no live artifact may cite superseded text (doc 10 §2.5)
// ---------------------------------------------------------------------------
export interface Inv8Violation {
  cardId: string;
  supersededSegmentId: string;
}
export function assertNoSupersededCitations(
  liveCards: ConceptCard[],
  supersededIds: Set<string>,
): { ok: boolean; violations: Inv8Violation[] } {
  const violations: Inv8Violation[] = [];
  for (const card of liveCards) {
    if (card.state === 'retracted') continue;
    for (const seg of cardCitedSegments(card)) {
      if (supersededIds.has(seg)) violations.push({ cardId: card.id, supersededSegmentId: seg });
    }
  }
  return { ok: violations.length === 0, violations };
}
