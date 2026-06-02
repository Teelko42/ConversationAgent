import { describe, it, expect } from 'vitest';
import {
  ConceptCardSchema,
  InsightItemSchema,
  KgDeltaSchema,
  makeTranscriptSegment,
  makeConsentContext,
  segId,
  SESSION,
  type TranscriptSegment,
  type ConceptCard,
  type InsightItem,
  type KgDelta,
} from '@aizen/contracts';
import { InMemorySessionBus } from '@aizen/edge-gateway';
import {
  LlmGateway,
  StubProvider,
  CostMeter,
  routeTier,
} from '@aizen/llm-gateway';
import { assertNoSupersededCitations } from '@aizen/seam-supersede';
import { extractFromFinal, salientTerms } from './extract.js';
import { runIntel, type F02Out } from './worker.js';
import { adapt } from '@aizen/adapter-d16';

// ---------------------------------------------------------------------------
// Deterministic test rig — fixed gateway, no wall-clock, no RNG (BD-03).
// ---------------------------------------------------------------------------
const newGateway = () =>
  new LlmGateway(
    new StubProvider(),
    new CostMeter({ tenantCeilingUsd: 1000, opusCallCap: 4 }),
  );

/** Publish a TranscriptSegment as an F01 envelope on the bus (Lane C's job). */
function publishFinal(
  bus: InMemorySessionBus,
  over: Partial<TranscriptSegment>,
): TranscriptSegment {
  const seq = bus.nextSeq(SESSION, 'f01');
  const seg = makeTranscriptSegment({ seq, segment_id: segId(seq), ...over });
  bus.publish(SESSION, seg);
  return seg;
}

/** Collect typed F02 payloads off the bus history. */
function f02Out(bus: InMemorySessionBus): F02Out[] {
  return bus
    .history(SESSION)
    .filter((e): e is F02Out => 'message_type' in e) as F02Out[];
}
const cardsOf = (bus: InMemorySessionBus): ConceptCard[] =>
  f02Out(bus).flatMap((e) => (e.message_type === 'concept_card' ? [e.card] : []));
const insightsOf = (bus: InMemorySessionBus): InsightItem[] =>
  f02Out(bus).flatMap((e) => (e.message_type === 'insight_item' ? [e.insight] : []));
const deltasOf = (bus: InMemorySessionBus): KgDelta[] =>
  f02Out(bus).flatMap((e) => (e.message_type === 'kg_delta' ? [e.delta] : []));

describe('Lane D — intel-worker F02 hot path (CT-INT-*)', () => {
  it('CT-INT-1: a salient term in a final yields a skeleton ConceptCard', async () => {
    const bus = new InMemorySessionBus();
    const h = runIntel(SESSION, bus, newGateway(), { consent: makeConsentContext() });
    publishFinal(bus, { text: 'So the quarterly ARR.', is_final: true });
    await h.drain();

    const cards = cardsOf(bus);
    expect(cards.length).toBeGreaterThan(0);
    const arr = cards.find((c) => c.surface_form === 'ARR');
    expect(arr).toBeDefined();
    expect(arr!.state).toBe('skeleton');
    // every emitted card is schema-valid (F02 §2).
    for (const c of cards) expect(ConceptCardSchema.safeParse(c).success).toBe(true);
  });

  it('CT-INT-2: every InsightItem carries ≥1 transcript citation (INV-4)', async () => {
    const bus = new InMemorySessionBus();
    const h = runIntel(SESSION, bus, newGateway(), { consent: makeConsentContext() });
    publishFinal(bus, { text: 'Acme shipped the API.', is_final: true });
    await h.drain();

    const insights = insightsOf(bus);
    expect(insights.length).toBeGreaterThan(0);
    for (const ins of insights) {
      expect(ins.evidence_segment_ids.length).toBeGreaterThanOrEqual(1); // INV-4
      expect(InsightItemSchema.safeParse(ins).success).toBe(true);
    }
  });

  it('CT-INT-3: a superseded segment retracts its card; INV-8 holds end-to-end', async () => {
    const bus = new InMemorySessionBus();
    const h = runIntel(SESSION, bus, newGateway(), { consent: makeConsentContext() });

    const original = publishFinal(bus, { text: 'The ARR figure.', is_final: true });
    await h.drain();
    expect(h.store.liveCards().length).toBeGreaterThan(0);

    // a correction final that supersedes the original.
    publishFinal(bus, {
      text: 'The MRR figure.',
      is_final: true,
      supersedes: original.segment_id,
    });
    await h.drain();

    // the original card is retracted (un-rendered) and a retraction was published.
    const retracted = cardsOf(bus).filter((c) => c.state === 'retracted');
    expect(retracted.length).toBeGreaterThan(0);
    expect(retracted[0]!.retraction?.reason).toBe('source_superseded');

    // INV-8: no LIVE card may still cite the superseded segment.
    const check = assertNoSupersededCitations(
      h.store.liveCards(),
      new Set([original.segment_id]),
    );
    expect(check.ok).toBe(true);
    expect(check.violations).toEqual([]);
  });

  it('CT-INT-4: kg_delta.delta_seq is monotonic across deltas in a session', async () => {
    const bus = new InMemorySessionBus();
    const h = runIntel(SESSION, bus, newGateway(), { consent: makeConsentContext() });
    publishFinal(bus, { text: 'Acme uses GPUs.', is_final: true });
    publishFinal(bus, { text: 'Beta needs RAM.', is_final: true });
    publishFinal(bus, { text: 'Gamma ships SDK.', is_final: true });
    await h.drain();

    const seqs = deltasOf(bus).map((d) => d.delta_seq);
    expect(seqs.length).toBe(3);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    for (const d of deltasOf(bus)) expect(KgDeltaSchema.safeParse(d).success).toBe(true);
  });

  it('CT-INT-5: consent fail-closed (no ctx) is preserved into emitted artifacts', async () => {
    const bus = new InMemorySessionBus();
    // NO consent context ⇒ adapter fails closed (sensitive + pii_present); D20.
    const h = runIntel(SESSION, bus, newGateway());
    publishFinal(bus, { text: 'The ARR figure.', is_final: true });
    await h.drain();

    const cards = cardsOf(bus);
    expect(cards.length).toBeGreaterThan(0);
    for (const c of cards) {
      expect(c.consent_class).toBe('sensitive'); // fail-closed propagated
      expect(c.pii_present).toBe(true);
    }
    for (const ins of insightsOf(bus)) {
      expect(ins.consent_class).toBe('sensitive');
      expect(ins.pii_present).toBe(true);
    }
  });

  it('CT-INT-6: partials do NOT trigger extraction (finals-only baseline)', async () => {
    const bus = new InMemorySessionBus();
    const h = runIntel(SESSION, bus, newGateway(), { consent: makeConsentContext() });
    // a partial (is_final:false) carrying a salient term.
    publishFinal(bus, { text: 'So the quarterly ARR.', is_final: false });
    await h.drain();

    expect(f02Out(bus).length).toBe(0); // nothing emitted on a partial
    expect(h.store.liveCards().length).toBe(0);
  });

  it('CT-INT-extract: extractFromFinal is deterministic and gateway-routed (extract→haiku)', async () => {
    expect(routeTier('extract')).toBe('haiku'); // D04 routing the worker relies on
    const input = adapt(makeTranscriptSegment({ text: 'The ARR figure.' }), makeConsentContext());
    const a = await extractFromFinal(input, newGateway(), 1);
    const b = await extractFromFinal(input, newGateway(), 1);
    expect(a).toEqual(b); // byte-stable: no wall-clock, no RNG
    expect(salientTerms('So the quarterly ARR.')).toEqual(['So', 'ARR']);
  });
});
