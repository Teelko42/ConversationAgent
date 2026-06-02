/**
 * @aizen/capture — Lane B source seam (BD-03).
 *
 * A `CaptureSource` yields raw, media-clock-stamped PCM chunks; `startCapture`
 * (capture.ts) turns those into seq'd `AudioFrame`s on the bus. The Phase-0
 * source is a deterministic fixture (`MockClipSource`) — no microphone, no
 * network, no wall-clock. The real mic/upload/meeting-bot sources swap in here
 * behind the same interface.
 */

/** One media-clock-stamped slice of audio. `samples` count, not bytes (Phase-0 has no real payload). */
export interface AudioChunk {
  /** media-clock offset from session_start, ms (monotonic non-decreasing). */
  startMs: number;
  /** chunk length on the media clock, ms. */
  durationMs: number;
  /** PCM sample count this chunk represents. */
  samples: number;
}

/** A source of audio chunks. Sync or async iterable so a real device can stream. */
export interface CaptureSource {
  frames(): Iterable<AudioChunk> | AsyncIterable<AudioChunk>;
}

/** 20 ms at 16 kHz mono = 320 samples — a typical frame quantum (doc 05). */
const DEFAULT_CHUNK_MS = 20;
const DEFAULT_SAMPLES_PER_CHUNK = 320;
const DEFAULT_CHUNK_COUNT = 5;

/** Build the deterministic default clip: contiguous, non-overlapping 20 ms chunks. */
function defaultChunks(): AudioChunk[] {
  const chunks: AudioChunk[] = [];
  for (let i = 0; i < DEFAULT_CHUNK_COUNT; i++) {
    chunks.push({
      startMs: i * DEFAULT_CHUNK_MS,
      durationMs: DEFAULT_CHUNK_MS,
      samples: DEFAULT_SAMPLES_PER_CHUNK,
    });
  }
  return chunks;
}

/**
 * Deterministic fixture source (BD-03 `Stub*`-style). Emits a fixed list of
 * contiguous PCM chunks with monotonic media-clock offsets — fully reproducible,
 * so capture tests never touch the clock or RNG.
 */
export class MockClipSource implements CaptureSource {
  private readonly chunks: readonly AudioChunk[];

  constructor(chunks: AudioChunk[] = defaultChunks()) {
    this.chunks = chunks;
  }

  frames(): Iterable<AudioChunk> {
    return this.chunks;
  }
}
