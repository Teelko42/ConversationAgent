import { describe, it, expect } from 'vitest';
import { makeConsentContext } from '@aizen/contracts';
import { MockClipSource, type AudioChunk } from '@aizen/capture';
import { StubSttProvider } from '@aizen/stt-worker';
import { LlmGateway, StubProvider, CostMeter } from '@aizen/llm-gateway';
import { renderStream } from '@aizen/web-client';
import { SessionConductor } from './conductor.js';

/**
 * Lane E — SessionConductor (CT-CON-*). The conductor builds one bus, gates on
 * consent, and wires capture→stt→intel. These tests assert the consent gate,
 * the wiring (a clip produces a transcript), and teardown — all deterministic.
 */

const newGateway = (): LlmGateway =>
  new LlmGateway(
    new StubProvider(),
    new CostMeter({ tenantCeilingUsd: 1000, opusCallCap: 4 }),
  );

/** A short speech clip + a closing endpoint frame so the utterance finalizes. */
function clip(): MockClipSource {
  const chunks: AudioChunk[] = [];
  for (let i = 0; i < 4; i++) chunks.push({ startMs: i * 20, durationMs: 20, samples: 320 });
  chunks.push({ startMs: 80, durationMs: 0, samples: 0 });
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

describe('Lane E — SessionConductor (CT-CON-*)', () => {
  it('CT-CON-1: start without a consent context is refused (fail-closed, D20)', () => {
    const conductor = new SessionConductor();
    expect(() => conductor.start('s1', { gateway: newGateway() })).toThrow(/consent/i);
    // no bus was created for a refused session.
    expect(() => conductor.bus('s1')).toThrow(/no live session/i);
  });

  it('CT-CON-1b: start with a not-all-cleared context is refused', () => {
    const conductor = new SessionConductor();
    const consent = makeConsentContext({ per_speaker: { spk_2: 'refused' } });
    expect(() => conductor.start('s1', { consent, gateway: newGateway() })).toThrow(/consent/i);
  });

  it('CT-CON-2: an admitted session wires capture→stt→intel; clip yields a transcript', async () => {
    const conductor = new SessionConductor();
    const session = 'con-2';
    conductor.start(session, {
      consent: makeConsentContext(),
      gateway: newGateway(),
      source: clip(),
      stt: new StubSttProvider({ wordsPerUtterance: 4 }),
    });
    await settle(conductor, session);

    const model = renderStream(conductor.bus(session), session);
    expect(model.transcript.length).toBeGreaterThan(0);
    expect(model.transcript.some((l) => l.is_final)).toBe(true);
    // a transcript is rendered in seq order.
    const seqs = model.transcript.map((l) => l.seq);
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    conductor.stop(session);
  });

  it('CT-CON-3: bus(session) exposes the same live bus the workers publish on', () => {
    const conductor = new SessionConductor();
    const session = 'con-3';
    const returned = conductor.start(session, {
      consent: makeConsentContext(),
      gateway: newGateway(),
      source: clip(),
      stt: new StubSttProvider({ wordsPerUtterance: 4 }),
    });
    expect(conductor.bus(session)).toBe(returned);
  });

  it('CT-CON-4: stop() is idempotent and forgets the session', async () => {
    const conductor = new SessionConductor();
    const session = 'con-4';
    conductor.start(session, {
      consent: makeConsentContext(),
      gateway: newGateway(),
      source: clip(),
      stt: new StubSttProvider({ wordsPerUtterance: 4 }),
    });
    await settle(conductor, session);
    conductor.stop(session);
    expect(() => conductor.bus(session)).toThrow(/no live session/i);
    expect(() => conductor.stop(session)).not.toThrow(); // idempotent
  });
});
