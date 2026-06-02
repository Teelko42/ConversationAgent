/**
 * run-spine — Lane E. Drives the Phase-0 spine end to end on a deterministic
 * fixture clip and prints the render: a `MockClipSource` (Lane B) →
 * `StubSttProvider` (Lane C) → `runIntel` with an `LlmGateway(new StubProvider(),
 * new CostMeter(...))` (Lane D) over one bus, all wired by the `SessionConductor`,
 * then rendered by the web-client. Runnable via `tsx` (no build, source aliases).
 *
 * Everything is deterministic (BD-03): the clip is fixed, the providers are
 * stubs, there is no wall-clock or RNG — so the printed transcript + cards are
 * byte-stable across runs. The clip ends with a silence (endpoint) frame so the
 * STT utterance finalizes and Lane D extracts at least one ConceptCard.
 */
import type { AudioChunk } from '@aizen/capture';
import { MockClipSource } from '@aizen/capture';
import { StubSttProvider } from '@aizen/stt-worker';
import { LlmGateway, StubProvider, CostMeter } from '@aizen/llm-gateway';
import { makeConsentContext } from '@aizen/contracts';
import { renderStream, formatRender } from '@aizen/web-client';

import { SessionConductor } from '../src/conductor.js';

/** A macrotask yield: lets capture's async drive loop advance one iteration. */
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** Run the spine until the bus log stops growing, then drain the intel chain. */
async function settle(
  conductor: SessionConductor,
  session: string,
): Promise<void> {
  let prev = -1;
  // capture drives an async loop; let it run to completion before draining.
  while (conductor.bus(session).history(session).length !== prev) {
    prev = conductor.bus(session).history(session).length;
    await tick();
    await conductor.drain(session);
  }
}

/**
 * A four-word speech clip plus a closing endpoint (silence) frame. Four words at
 * `wordsPerUtterance:4` finalize the utterance "so the quarterly ARR"; the
 * trailing silence frame guarantees closure even if the count changes.
 */
function clipChunks(): AudioChunk[] {
  const speech: AudioChunk[] = [];
  for (let i = 0; i < 4; i++) {
    speech.push({ startMs: i * 20, durationMs: 20, samples: 320 });
  }
  // endpoint frame: `samples:0` closes any in-flight utterance with a final.
  speech.push({ startMs: 80, durationMs: 0, samples: 0 });
  return speech;
}

async function main(): Promise<void> {
  const session = 'run-spine-session';
  const conductor = new SessionConductor();

  const gateway = new LlmGateway(
    new StubProvider(),
    new CostMeter({ tenantCeilingUsd: 1000, opusCallCap: 4 }),
  );

  conductor.start(session, {
    consent: makeConsentContext(),
    gateway,
    source: new MockClipSource(clipChunks()),
    stt: new StubSttProvider({ wordsPerUtterance: 4 }),
  });

  await settle(conductor, session);

  const model = renderStream(conductor.bus(session), session);
  conductor.stop(session);

  for (const line of formatRender(model)) {
    // eslint-disable-next-line no-console -- this script's whole job is to print.
    console.log(line);
  }

  if (model.cards.length < 1) {
    throw new Error('run-spine: expected >=1 concept card, got 0');
  }
}

void main();
