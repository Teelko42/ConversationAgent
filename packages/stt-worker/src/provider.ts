/**
 * Lane C — the STT seam (BD-03). `SttProvider` is the vendor-neutral interface;
 * `StubSttProvider` is the deterministic Phase-0 stand-in (Deepgram swaps in at
 * P1, MAN-F01-002). No network, no wall-clock, no RNG — frames map to words by a
 * fixed table so every run reproduces the same partial→final lifecycle.
 *
 * Lifecycle reproduced (F01 data-contracts §3.4): an utterance accrues as one or
 * more `is_final:false` partials (each a higher `rev` of the SAME `segment_id`),
 * then closes with a single `is_final:true` final whose `rev` is higher still and
 * whose `supersedes` points at the last partial it replaces. This is the exact
 * `rev`/`supersedes` behavior the supersede seam (INV-8) downstream relies on.
 */
import type { AudioFrame, TranscriptSegment } from '@aizen/contracts';

/** One provider emission (kept as a struct so real providers can carry extras). */
export interface SttResult {
  segment: TranscriptSegment;
}

/**
 * Vendor-neutral STT. `transcribe` is fed one `AudioFrame` at a time and yields
 * zero or more `TranscriptSegment`s for it (partials and/or a final). Providers
 * are stateful across calls within a session (an utterance spans frames).
 */
export interface SttProvider {
  transcribe(frame: AudioFrame): Iterable<TranscriptSegment>;
}

/** Deterministic word table — frame index → the word that frame "recognized". */
const WORDS = ['so', 'the', 'quarterly', 'ARR', 'is', 'up'] as const;

/** Fixed wall-clock µs base (observability only; never used to order media). */
const EMITTED_AT_BASE = 1748707201987000;

/** Deterministic confidence band from a partial-vs-final/confidence pair (D05). */
function bandFor(isFinal: boolean): TranscriptSegment['confidence_band'] {
  return isFinal ? 'high' : 'medium';
}

/**
 * Deterministic stub STT (BD-03, mirrors `StubProvider` in `@aizen/llm-gateway`).
 *
 * Each `transcribe(frame)` appends one word to the in-flight utterance and emits
 * a growing `is_final:false` partial. An utterance closes — emitting the terminal
 * `is_final:true` final — when a boundary frame arrives: a `samples === 0`
 * (silence/endpoint) frame, or once `wordsPerUtterance` words have accrued. The
 * final reuses the utterance's `segment_id`, carries a strictly higher `rev`, and
 * sets `supersedes` to the last partial's `segment_id` (here == the final's, the
 * same logical segment being finalized — §3.4 correction semantics).
 */
export class StubSttProvider implements SttProvider {
  private readonly wordsPerUtterance: number;
  /** segment_id of the in-flight utterance (null between utterances). */
  private segmentId: string | null = null;
  /** monotonic rev within the in-flight utterance. */
  private rev = 0;
  /** word indices accrued in the in-flight utterance. */
  private acc: number[] = [];
  /** start_ms of the in-flight utterance's first frame. */
  private utteranceStartMs = 0;
  /** running word cursor into WORDS (wraps), for cross-utterance variety. */
  private cursor = 0;

  constructor(opts: { wordsPerUtterance?: number } = {}) {
    this.wordsPerUtterance = opts.wordsPerUtterance ?? 3;
  }

  *transcribe(frame: AudioFrame): Iterable<TranscriptSegment> {
    const isBoundary = frame.samples === 0;

    if (!isBoundary) {
      // Accrue a word and emit a growing partial.
      if (this.segmentId === null) {
        // open a new utterance keyed on this frame's seq (deterministic id).
        this.segmentId = `${frame.session_id}:seg:${frame.seq}`;
        this.utteranceStartMs = frame.start_ms;
        this.rev = 0;
        this.acc = [];
      }
      this.acc.push(this.cursor % WORDS.length);
      this.cursor += 1;
      yield this.makeSegment(frame, false);

      // Once enough words have accrued, close the utterance with a final.
      if (this.acc.length >= this.wordsPerUtterance) {
        yield this.finalize(frame);
      }
      return;
    }

    // Boundary frame: close any in-flight utterance with its final.
    if (this.segmentId !== null) {
      yield this.finalize(frame);
    }
  }

  /** Emit the terminal final for the in-flight utterance, then reset. */
  private finalize(frame: AudioFrame): TranscriptSegment {
    const seg = this.makeSegment(frame, true);
    this.segmentId = null;
    this.acc = [];
    return seg;
  }

  /** Build a `TranscriptSegment` for the in-flight utterance (partial or final). */
  private makeSegment(frame: AudioFrame, isFinal: boolean): TranscriptSegment {
    const segmentId = this.segmentId!;
    this.rev += 1;
    const text = this.acc.map((i) => WORDS[i]).join(' ');
    const endMs = frame.start_ms + frame.duration_ms;
    return {
      schema_version: '1.0.0',
      tenant_id: frame.tenant_id,
      session_id: frame.session_id,
      seq: 0, // assigned by the worker via the bus before publish
      producer_id: 'stub-stt-worker',
      emitted_at: EMITTED_AT_BASE + this.rev,
      segment_id: segmentId,
      rev: this.rev,
      is_final: isFinal,
      // §3.4: the final replaces the last partial of the SAME segment.
      supersedes: isFinal ? segmentId : null,
      start_ms: this.utteranceStartMs,
      end_ms: endMs,
      session_start_at: frame.session_start_at,
      text,
      language: 'en-US',
      confidence: isFinal ? 0.94 : 0.78,
      confidence_band: bandFor(isFinal),
      speaker: {
        speaker_id: 'spk_1',
        speaker_confidence: 0.88,
        participant_id: 'p_01',
        display_name: 'Speaker 1',
        channel_role: frame.source.channel_role,
        is_overlap: false,
        diarization_method: 'online_clustering',
      },
      consent: {
        mode: frame.consent.mode,
        consent_id: frame.consent.consent_id,
        pii_redacted: false,
      },
    };
  }
}
