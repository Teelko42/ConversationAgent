/**
 * Lane C — the *streaming* STT seam (P1). The Phase-0 `SttProvider` is a
 * synchronous pull (`transcribe(frame): Iterable<…>`) suited to the deterministic
 * fixture clip. A real provider (Deepgram) is the opposite shape: audio bytes go
 * in continuously and `TranscriptSegment`s come back asynchronously, decoupled
 * from any single frame. This module defines that vendor-neutral push interface
 * so `DeepgramSttProvider` (and a meeting-bot/upload source later) all swap in
 * behind it (BD-03), and `runStreamingStt` wires its emissions onto the BD-01 bus.
 */
import type { TranscriptSegment } from '@aizen/contracts';
import type { SessionEventBus } from '@aizen/edge-gateway';

/** A consumer of finished/partial segments produced by a streaming session. */
export type SegmentSink = (segment: TranscriptSegment) => void;

/** Per-session config a streaming provider needs to stamp valid F01 envelopes. */
export interface StreamingSttConfig {
  /** Canonical session UUID (TranscriptSegment.session_id is a uuid). */
  session_id: string;
  /** Canonical tenant UUID (TranscriptSegment.tenant_id is a uuid). */
  tenant_id: string;
  /** BCP-47 primary language hint. Default 'en-US'. */
  language?: string;
  /** Provider model id (e.g. Deepgram 'nova-2'/'nova-3'). Provider-specific default. */
  model?: string;
  /** Consent passthrough stamped on every emitted segment (D10). */
  consentMode?: 'store_audio' | 'no_audio_retention' | 'transcript_only';
  consentId?: string;
}

/** A live streaming STT connection. Feed audio, then `finish()` to flush + close. */
export interface StreamingSttSession {
  /** Feed raw PCM16LE mono audio at the configured sample rate (default 16 kHz). */
  sendAudio(pcm: Uint8Array | ArrayBufferView | ArrayBuffer): void;
  /** Flush any in-flight utterance, close the connection, resolve when done. */
  finish(): Promise<void>;
}

/** Opens streaming STT connections. The real provider owns the vendor socket. */
export interface StreamingSttProvider {
  open(cfg: StreamingSttConfig, onSegment: SegmentSink): Promise<StreamingSttSession>;
}

/** Handle returned by `runStreamingStt`. */
export interface StreamingSttHandle {
  /** Feed audio bytes into the live provider session. */
  sendAudio(pcm: Uint8Array | ArrayBufferView | ArrayBuffer): void;
  /** Flush + close the provider session. */
  stop(): Promise<void>;
}

/**
 * Open a streaming STT session for `session` and publish every emitted
 * `TranscriptSegment` onto the bus as an F01 envelope with a bus-assigned `seq`
 * (BD-01: `seq` is the bus's to mint). Mirrors `runStt`, but push-driven: the
 * provider emits on its own schedule rather than once per polled frame.
 */
export async function runStreamingStt(
  session: string,
  bus: SessionEventBus,
  provider: StreamingSttProvider,
  cfg: StreamingSttConfig,
): Promise<StreamingSttHandle> {
  const sess = await provider.open(cfg, (seg) => {
    const seq = bus.nextSeq(session, 'f01');
    bus.publish(session, { ...seg, seq });
  });
  return {
    sendAudio: (pcm) => sess.sendAudio(pcm),
    stop: () => sess.finish(),
  };
}
