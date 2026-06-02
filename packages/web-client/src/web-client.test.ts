import { describe, it, expect } from 'vitest';
import {
  makeTranscriptSegment,
  makeConceptCard,
  segId,
  SESSION,
  type InsightItem,
  type ConceptCard,
} from '@aizen/contracts';
import { InMemorySessionBus } from '@aizen/edge-gateway';
import { renderStream, formatRender } from './index.js';

/**
 * Lane E — web-client render (CT-WC-*). The renderer is a pure fold over the
 * BD-01 bus history: it must keep transcript in seq order, surface cards/insights
 * off the F02 envelopes, and UN-render a card on a `retracted` revision (INV-8).
 * Everything here is deterministic — fixed fixtures, no clock, no RNG.
 */

/** Publish a TranscriptSegment as an F01 envelope with a bus-assigned seq. */
function pushSegment(bus: InMemorySessionBus, text: string, isFinal: boolean): string {
  const seq = bus.nextSeq(SESSION, 'f01');
  const seg = makeTranscriptSegment({
    seq,
    segment_id: segId(seq),
    text,
    is_final: isFinal,
    supersedes: null,
  });
  bus.publish(SESSION, seg);
  return seg.segment_id;
}

/** Publish a ConceptCard wrapped in its F02 routing envelope (intel-worker's shape). */
function pushCard(bus: InMemorySessionBus, card: ConceptCard): void {
  const seq = bus.nextSeq(SESSION, 'f02');
  bus.publish(SESSION, {
    schema_version: '1.0.0',
    message_type: 'concept_card',
    session_id: SESSION,
    tenant_id: card.tenant_id,
    seq,
    ts_emit: 1748707202000000,
    producer: 'intel-worker',
    trace_id: `trace_${SESSION}_f02_${seq}`,
    card,
  } as never);
}

/** Publish an InsightItem wrapped in its F02 routing envelope. */
function pushInsight(bus: InMemorySessionBus, insight: InsightItem): void {
  const seq = bus.nextSeq(SESSION, 'f02');
  bus.publish(SESSION, {
    schema_version: '1.0.0',
    message_type: 'insight_item',
    session_id: SESSION,
    tenant_id: insight.tenant_id,
    seq,
    ts_emit: 1748707202000000,
    producer: 'intel-worker',
    trace_id: `trace_${SESSION}_f02_${seq}`,
    insight,
  } as never);
}

describe('Lane E — web-client render (CT-WC-*)', () => {
  it('CT-WC-1: transcript renders in seq order', () => {
    const bus = new InMemorySessionBus();
    pushSegment(bus, 'one', false);
    pushSegment(bus, 'two', false);
    pushSegment(bus, 'three', true);

    const model = renderStream(bus, SESSION);
    expect(model.transcript.map((l) => l.text)).toEqual(['one', 'two', 'three']);
    const seqs = model.transcript.map((l) => l.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
  });

  it('CT-WC-2: concept cards and insights surface off F02 envelopes', () => {
    const bus = new InMemorySessionBus();
    pushSegment(bus, 'So the quarterly ARR.', true);
    const card = makeConceptCard({ state: 'skeleton' });
    pushCard(bus, card);
    pushInsight(bus, {
      id: 'ins_1',
      revision: 1,
      session_id: SESSION,
      tenant_id: card.tenant_id,
      insight_type: 'open_question',
      status: 'open',
      text: 'ARR',
      owner_speaker_id: 'spk_2',
      evidence_segment_ids: [segId(0)],
      first_seen_t_us: 256480000,
      consent_class: 'standard',
      pii_present: false,
    });

    const model = renderStream(bus, SESSION);
    expect(model.cards).toHaveLength(1);
    expect(model.cards[0]!.surface_form).toBe('ARR');
    expect(model.insights).toHaveLength(1);
    expect(model.insights[0]!.evidence_segment_ids.length).toBeGreaterThanOrEqual(1);
  });

  it('CT-WC-3: latest card revision wins (dedup by stable id)', () => {
    const bus = new InMemorySessionBus();
    const v1 = makeConceptCard({ id: 'cc_x', revision: 1, state: 'skeleton' });
    const v2 = makeConceptCard({ id: 'cc_x', revision: 2, state: 'enriched' });
    pushCard(bus, v1);
    pushCard(bus, v2);

    const model = renderStream(bus, SESSION);
    expect(model.cards).toHaveLength(1);
    expect(model.cards[0]!.state).toBe('enriched');
  });

  it('CT-WC-4: a retracted card revision un-renders the card (INV-8)', () => {
    const bus = new InMemorySessionBus();
    const live = makeConceptCard({ id: 'cc_x', revision: 1, state: 'skeleton', retraction: null });
    const retracted = makeConceptCard({
      id: 'cc_x',
      revision: 2,
      state: 'retracted',
      retraction: {
        reason: 'source_superseded',
        superseded_segment_id: segId(0),
        replacement_card_id: null,
      },
    });
    pushCard(bus, live);
    expect(renderStream(bus, SESSION).cards).toHaveLength(1);

    pushCard(bus, retracted);
    expect(renderStream(bus, SESSION).cards).toHaveLength(0); // un-rendered
  });

  it('CT-WC-5: formatRender prints a transcript + cards + insights block', () => {
    const bus = new InMemorySessionBus();
    pushSegment(bus, 'So the quarterly ARR.', true);
    pushCard(bus, makeConceptCard({ state: 'skeleton' }));

    const out = formatRender(renderStream(bus, SESSION));
    expect(out.some((l) => l.includes('transcript'))).toBe(true);
    expect(out.some((l) => l.includes('concept cards'))).toBe(true);
    expect(out.some((l) => l.includes('ARR'))).toBe(true);
  });
});
