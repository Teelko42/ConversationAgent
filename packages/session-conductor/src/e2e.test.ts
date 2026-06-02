import { describe, it, expect } from 'vitest';
import {
  makeConsentContext,
  type TranscriptSegment,
  type ConceptCard,
  type InsightItem,
} from '@aizen/contracts';
import { MockClipSource, type AudioChunk } from '@aizen/capture';
import { StubSttProvider } from '@aizen/stt-worker';
import { LlmGateway, StubProvider, CostMeter } from '@aizen/llm-gateway';
import { assertNoSupersededCitations } from '@aizen/seam-supersede';
import { renderStream } from '@aizen/web-client';
import { SessionConductor } from './conductor.js';

/**
 * CT-E2E-1 (BD-05) — the Phase-0 exit test. One deterministic fixture clip flows
 * the WHOLE spine through the `SessionConductor`:
 *   clip → AudioFrame (Lane B) → StubSttProvider → TranscriptSegment (Lane C) →
 *   bus → runIntel → ConceptCard + InsightItem + kg_delta (Lane D) → bus →
 *   web-client render (Lane E).
 * Then it drives a supersede correction and asserts INV-8 holds end to end.
 *
 * Fully deterministic (BD-03): fixed clip, stub providers, no wall-clock, no RNG.
 */

const newGateway = (): LlmGateway =>
  new LlmGateway(
    new StubProvider(),
    new CostMeter({ tenantCeilingUsd: 1000, opusCallCap: 4 }),
  );

/** The fixture clip: four speech frames ("so the quarterly ARR") + an endpoint. */
function fixtureClip(): MockClipSource {
  const chunks: AudioChunk[] = [];
  for (let i = 0; i < 4; i++) chunks.push({ startMs: i * 20, durationMs: 20, samples: 320 });
  chunks.push({ startMs: 80, durationMs: 0, samples: 0 }); // endpoint → finalize
  return new MockClipSource(chunks);
}

/** A macrotask yield: lets capture's async drive loop advance one iteration. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Run the spine until the bus stops growing, then drain the intel chain. */
async function settle(conductor: SessionConductor, session: string): Promise<void> {
  let prev = -1;
  while (conductor.bus(session).history(session).length !== prev) {
    prev = conductor.bus(session).history(session).length;
    await tick();
    await conductor.drain(session);
  }
}

/** Pull the F01 final segments off the rendered transcript's underlying log. */
function finalSegments(conductor: SessionConductor, session: string): TranscriptSegment[] {
  return conductor
    .bus(session)
    .history(session)
    .filter(
      (e): e is TranscriptSegment =>
        !('message_type' in e) && 'is_final' in e && (e as TranscriptSegment).is_final,
    );
}

describe('CT-E2E-1 (BD-05) — Phase-0 spine end to end', () => {
  it('drives one fixture clip through the conductor and renders the result', async () => {
    const conductor = new SessionConductor();
    const session = 'e2e';
    conductor.start(session, {
      consent: makeConsentContext(),
      gateway: newGateway(),
      source: fixtureClip(),
      stt: new StubSttProvider({ wordsPerUtterance: 4 }),
    });
    await settle(conductor, session);

    const model = renderStream(conductor.bus(session), session);

    // (1) transcript rendered in seq order.
    expect(model.transcript.length).toBeGreaterThan(0);
    const seqs = model.transcript.map((l) => l.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);

    // (2) ≥1 concept card rendered (MVP exit criterion 1, doc 03 §6).
    expect(model.cards.length).toBeGreaterThanOrEqual(1);

    // (3) every rendered InsightItem cites ≥1 transcript segment (INV-4).
    expect(model.insights.length).toBeGreaterThan(0);
    for (const ins of model.insights as InsightItem[]) {
      expect(ins.evidence_segment_ids.length).toBeGreaterThanOrEqual(1);
    }

    conductor.stop(session);
  });

  it('a superseded segment retracts its card; INV-8 holds end to end', async () => {
    const conductor = new SessionConductor();
    const session = 'e2e-supersede';
    const bus = conductor.start(session, {
      consent: makeConsentContext(),
      gateway: newGateway(),
      source: fixtureClip(),
      stt: new StubSttProvider({ wordsPerUtterance: 4 }),
    });
    await settle(conductor, session);

    // the clip's final whose ARR card we are about to supersede.
    const finals = finalSegments(conductor, session);
    expect(finals.length).toBeGreaterThan(0);
    const original = finals.at(-1)!;

    const before = renderStream(bus, session);
    const supersededCard = before.cards.find((c: ConceptCard) =>
      c.mention_segment_ids?.includes(original.segment_id),
    );
    expect(supersededCard).toBeDefined();

    // publish a correction final that supersedes the original (Lane C would emit
    // this on a post-edit; here we inject it directly onto the same bus).
    const seq = bus.nextSeq(session, 'f01');
    const correction: TranscriptSegment = {
      ...original,
      seq,
      segment_id: `${original.segment_id}:corr`,
      rev: original.rev + 1,
      text: 'So the quarterly MRR.',
      supersedes: original.segment_id,
    };
    bus.publish(session, correction);
    await settle(conductor, session);

    const after = renderStream(bus, session);

    // the superseded segment's card is retracted (un-rendered) in the final render.
    expect(after.cards.some((c) => c.id === supersededCard!.id)).toBe(false);

    // INV-8: no LIVE rendered card may still cite the superseded segment.
    const check = assertNoSupersededCitations(
      after.cards,
      new Set([original.segment_id]),
    );
    expect(check.ok).toBe(true);
    expect(check.violations).toEqual([]);

    conductor.stop(session);
  });
});
