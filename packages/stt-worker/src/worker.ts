/**
 * Lane C — the STT worker. Subscribes to F01 `AudioFrame`s on the per-session
 * bus (BD-01), drives an `SttProvider` (the `StubSttProvider` by default, BD-03),
 * and republishes the resulting `TranscriptSegment`s — also F01 (PLAN §Public
 * API) — with `seq` assigned by the bus (`nextSeq(session,'f01')`).
 *
 * The bus carries both AudioFrames and TranscriptSegments as F01 envelopes, so
 * we discriminate on `codec`: only AudioFrames carry it. Our own emitted
 * segments are skipped (they have no `codec`), avoiding a feedback loop.
 */
import type { AudioFrame } from '@aizen/contracts';
import type { Envelope, SessionEventBus } from '@aizen/edge-gateway';
import type { SttProvider } from './provider.js';
import { StubSttProvider } from './provider.js';

/** Handle returned by `runStt`; `stop()` unsubscribes from the bus. */
export interface SttHandle {
  stop(): void;
}

/** F01 envelopes that are AudioFrames carry `codec`; TranscriptSegments do not. */
function isAudioFrame(env: Envelope): env is AudioFrame {
  return !('message_type' in env) && 'codec' in env;
}

/**
 * Run the STT worker for `session`: subscribe from seq 0, transcribe every
 * `AudioFrame`, and publish each produced `TranscriptSegment` in order with a
 * bus-assigned F01 `seq`. Returns a handle whose `stop()` detaches the worker.
 */
export function runStt(
  session: string,
  bus: SessionEventBus,
  provider: SttProvider = new StubSttProvider(),
): SttHandle {
  const unsubscribe = bus.subscribe(session, 0, (env) => {
    if (!isAudioFrame(env)) return;
    for (const seg of provider.transcribe(env)) {
      // assign the next F01 seq at publish time, in emission order.
      const seq = bus.nextSeq(session, 'f01');
      bus.publish(session, { ...seg, seq });
    }
  });
  return { stop: unsubscribe };
}
