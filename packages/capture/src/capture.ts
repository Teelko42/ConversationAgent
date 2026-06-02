/**
 * @aizen/capture — Lane B drive loop. Pulls `AudioChunk`s from a `CaptureSource`,
 * builds spec-valid `AudioFrame`s (F01 data-contracts §2), and publishes each on
 * the per-session bus with a gateway-assigned `seq` (BD-01: `seq` is the bus's
 * to mint, never the producer's). Two clock domains stay separate (D06): the
 * frame's `start_ms`/`duration_ms` ride the media clock from the chunk;
 * `session_start_at`/`emitted_at` are wall-clock fields, here fixed integer
 * constants so the spine stays deterministic (no `Date.now()` / RNG).
 */
import type { AudioFrame } from '@aizen/contracts';
import type { SessionEventBus } from '@aizen/edge-gateway';
import type { CaptureSource } from './source.js';

import { TENANT, SESSION } from '@aizen/contracts';

/** F01 seq-assignment class for audio/transcript (doc 05). */
const F01_CLASS = 'f01' as const;

/** Phase-0 fixed wall-clock anchors (µs epoch), mirroring fixtures.ts. */
const SESSION_START_AT = 1748706943000000;
const EMITTED_AT = 1748707201987000;

/** Capture handle: the caller stops the drive loop with `stop()`. */
export interface CaptureHandle {
  stop(): void;
}

/** Per-frame fixed audio shape — Phase-0 carries no real bytes (BD-03). */
const CODEC = 'pcm_s16le' as const;
const SAMPLE_RATE_HZ = 16000;
const CHANNELS = 1;

/**
 * Start publishing `AudioFrame`s from `source` onto `bus` for `session`. Returns
 * immediately with a handle; frames flow as the (sync or async) source yields.
 * Each frame's `seq` comes from `bus.nextSeq(session, 'f01')` and is published in
 * that order, so the bus's strict-next check (BD-01) always holds.
 */
export function startCapture(
  session: string,
  source: CaptureSource,
  bus: SessionEventBus,
  opts: { tenantId?: string } = {},
): CaptureHandle {
  const tenantId = opts.tenantId ?? TENANT;
  // `SESSION` is the canonical fixture UUID; the schema requires a UUID, so a
  // non-UUID `session` string still produces a UUID `session_id` field.
  const sessionId = session === SESSION ? session : SESSION;

  let stopped = false;

  const buildFrame = (
    chunk: { startMs: number; durationMs: number; samples: number },
    seq: number,
  ): AudioFrame => ({
    schema_version: '1.0.0',
    tenant_id: tenantId,
    session_id: sessionId,
    seq,
    producer_id: 'capture-1',
    emitted_at: EMITTED_AT,
    start_ms: chunk.startMs,
    duration_ms: chunk.durationMs,
    session_start_at: SESSION_START_AT,
    codec: CODEC,
    sample_rate_hz: SAMPLE_RATE_HZ,
    channels: CHANNELS,
    samples: chunk.samples,
    payload: null,
    payload_ref: null,
    source: {
      kind: 'upload',
      platform: 'web',
      meeting_provider: null,
      channel_role: 'local_participant',
      participant_hint: null,
    },
    consent: {
      mode: 'store_audio',
      consent_id: 'c_88',
      redaction_pending: false,
    },
  });

  // Drive the source asynchronously; a sync iterable is consumed via for-await
  // too (for-await accepts both). `stop()` flips the flag and the loop exits.
  void (async () => {
    for await (const chunk of source.frames()) {
      if (stopped) break;
      const seq = bus.nextSeq(session, F01_CLASS);
      bus.publish(session, buildFrame(chunk, seq));
    }
  })();

  return {
    stop(): void {
      stopped = true;
    },
  };
}
